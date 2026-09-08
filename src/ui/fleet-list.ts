/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows workflow runs and subagents in one rounded card below the editor.
 * Empty prompt + ↓ / Ctrl+N selects the first row; Enter opens its inspector
 * or conversation. The local bottom navigator continues into footer statuses.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { Editor, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { type AgentActivity, describeActivity, formatCost, SPINNER, type Theme } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { boxBottom, boxRow, boxTop, formatClock, rightAlign } from "./fleet-card.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;
const BOTTOM_NAVIGATION = Symbol.for("pi.local.bottomNavigation.v1");
interface BottomNavigation {
  register(zone: {
    id: "fleet";
    items: () => { id: string; open: () => void | Promise<void> }[];
    select: (id: string | undefined) => void;
  }): () => void;
  reconcile(): void;
}

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type AgentEntry = { kind: "agent"; record: AgentRecord };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = WorkflowEntry | AgentEntry;

function rowId(entry: FleetEntry): string {
  return `${entry.kind}:${entry.kind === "agent" ? entry.record.id : entry.workflow.id}`;
}

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** Index into the visible workflow/agent roster. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;
  private navigation: BottomNavigation | undefined;
  private unregisterNavigation: (() => void) | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * The user's `viewerMarkdown` setting, for a conversation overlay opened
     * from here. Read live rather than captured, because the viewer's `m` key
     * changes it while the overlay is up. Omitted → the viewer's own default.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m` in that overlay, so the key means the same
     * thing here as it does from `/agents` — one setting, not one per entry
     * point. Omitted → `m` still cycles, viewer-locally.
     */
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.releaseNavigation();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    this.releaseNavigation();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;
    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    const hasRows = this.enabled && this.roster().length > 0;

    if (!hasRows) {
      this.releaseNavigation();
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        this.bindNavigation();
        return {
          render: (w: number) => { this.bindNavigation(); return this.renderBar(w, theme); },
          invalidate: () => { this.releaseNavigation(); this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private releaseNavigation(): void {
    this.unregisterNavigation?.();
    this.unregisterNavigation = undefined;
    this.navigation = undefined;
  }

  private bindNavigation(): void {
    if (!this.tui) return;
    const registry = (globalThis as typeof globalThis & {
      [BOTTOM_NAVIGATION]?: WeakMap<object, BottomNavigation>;
    })[BOTTOM_NAVIGATION];
    const navigation = registry?.get(this.tui);
    if (!navigation || navigation === this.navigation) return;
    this.releaseNavigation();
    this.navigation = navigation;
    this.unregisterNavigation = navigation.register({
      id: "fleet",
      items: () => this.enabled ? this.roster().map(entry => ({
        id: rowId(entry),
        open: () => {
          this.selectedIndex = this.roster().findIndex(row => rowId(row) === rowId(entry));
          return this.openSelected();
        },
      })) : [],
      select: id => {
        this.active = id !== undefined;
        if (id) this.selectedIndex = Math.max(0, this.roster().findIndex(entry => rowId(entry) === id));
      },
    });
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Pending agents with no session yet are hidden until they start.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a) && a.session && (
        a.status === "running" || a.status === "queued"
        || a.id === this.viewingAgentId
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || run.id === this.viewingWorkflowId
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    this.bindNavigation();
    if (this.navigation) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingWorkflowId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      const isActivator = matchesKey(data, "down") || matchesKey(data, "ctrl+n") || matchesKey(data, "left");
      if (isActivator && this.roster().length > 0 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows and Emacs keys navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void | Promise<void> {
    const entry = this.roster()[this.selectedIndex];
    if (!entry) {
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      return Promise.resolve(this.openWorkflow?.(entry.workflow.id)).then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    return this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
          this.viewerMarkdown,
          this.onViewerMarkdown,
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId ?? this.viewingWorkflowId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed : e.workflow.id === viewed,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    this.navigation?.reconcile();
    const rows = this.roster();
    if (rows.length === 0 || width < 4) return [];
    const sel = Math.min(this.selectedIndex, rows.length - 1);
    const agents = rows.filter((row): row is AgentEntry => row.kind === "agent");
    const running = agents.filter(row => row.record.status === "running").length;
    const queued = agents.filter(row => row.record.status === "queued").length;
    const workflows = rows.length - agents.length;
    const count: string[] = [];
    if (running) count.push(`${running} running`);
    if (queued) count.push(`${queued} queued`);
    if (workflows) count.push(`${workflows} workflow${workflows === 1 ? "" : "s"}`);
    if (this.active) count.push("enter view");

    const innerW = width - 4;
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const start = sel < visible ? 0 : sel - visible + 1;
    const hiddenBelow = rows.length - start - visible;
    const body: string[] = [];
    if (start > 0) body.push(theme.fg("dim", `↑ ${start} more`));
    for (let index = start; index < start + visible; index++) {
      const row = rows[index];
      body.push(row.kind === "workflow"
        ? this.renderWorkflowRow(index, sel, row.workflow, innerW, theme)
        : this.renderAgentRow(index, sel, row.record, innerW, theme));
    }
    if (hiddenBelow > 0) body.push(theme.fg("dim", `↓ ${hiddenBelow} more`));
    return [
      boxTop(width, "Subagents", count.join(" · "), theme),
      ...body.map(line => boxRow(width, line, theme)),
      boxBottom(width, theme),
    ];
  }

  private renderWorkflowRow(index: number, sel: number, workflow: FleetWorkflow, width: number, theme: Theme): string {
    const selected = this.active && index === sel;
    const mark = selected ? theme.fg("accent", "❯") : " ";
    const name = selected ? theme.bold(theme.fg("text", workflow.name)) : workflow.name;
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const left = `${mark} ${theme.fg("accent", "◆")} ${formatClock(elapsed)}  ${name} ${theme.fg("muted", "(workflow)")}`;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const right = `${workflow.status} · ${agents} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, theme.fg(selected ? "text" : "dim", right), width);
  }

  private renderAgentRow(index: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    const selected = this.active && index === sel;
    const mark = selected ? theme.fg("accent", "❯") : " ";
    const running = record.status === "running";
    const icon = running ? theme.fg("accent", SPINNER[Math.floor(Date.now() / 80) % SPINNER.length])
      : record.status === "queued" ? theme.fg("muted", "◦")
      : record.status === "completed" ? theme.fg("success", "✓")
      : theme.fg(record.status === "error" ? "error" : "warning", "■");
    const description = record.description?.trim();
    const typeName = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const title = description ? (selected ? theme.bold(theme.fg("text", description)) : description) : typeName;
    const typeTag = description ? ` (${typeName})` : "";
    const clock = formatClock((record.completedAt ?? Date.now()) - record.startedAt);
    const left = `${mark} ${icon} ${clock}  ${title}${typeTag}`;
    const activity = this.agentActivity.get(record.id);
    let status = record.status === "queued" ? "waiting" : String(record.status);
    if (running) {
      const phase = activity?.activeTools.size ? describeActivity(activity.activeTools)
        : activity?.responseText.trim() ? "streaming" : "thinking";
      status = `active · ${phase}`;
    }
    if (this.showCost()) {
      const cost = formatCost(getLifetimeCost(record.lifetimeUsage));
      status += ` · ${formatFleetTokens(getLifetimeTotal(record.lifetimeUsage))}${cost ? ` · ${cost}` : ""}`;
    }
    return rightAlign(left, theme.fg(selected ? "text" : "dim", status), width);
  }
}
