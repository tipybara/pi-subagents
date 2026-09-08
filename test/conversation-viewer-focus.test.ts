import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord, ViewerMarkdownMode } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

type Message = AgentSession["messages"][number];

const text = (value: string): TextContent => ({ type: "text", text: value });
const call = (): ToolCall => ({ type: "toolCall", id: "tool-1", name: "private_tool", arguments: { path: "/private/argument" } });
const user = (value: string): Message => ({ role: "user", content: value, timestamp: 0 });

function assistant(content: AssistantMessage["content"] = [], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0, ...overrides,
  };
}

function result(value = "private result payload"): ToolResultMessage {
  return { role: "toolResult", toolCallId: "tool-1", toolName: "private_tool", content: [text(value)], isError: true, timestamp: 0 };
}

const bash: Message = {
  role: "bashExecution", command: "private-command", output: "private bash output",
  exitCode: 1, cancelled: false, truncated: false, timestamp: 0,
};

function makeViewer(messages: Message[] = [], opts: {
  rows?: number;
  record?: Partial<AgentRecord>;
  activity?: AgentActivity;
  mode?: ViewerMarkdownMode;
  onMode?: (mode: ViewerMarkdownMode) => void;
  onStop?: () => void;
  onSteer?: (message: string) => void;
} = {}) {
  const tui = { terminal: { rows: opts.rows ?? 200, columns: 200 }, requestRender: vi.fn() };
  const unsubscribe = vi.fn();
  let listener: (() => void) | undefined;
  const state: { streamingMessage?: Message } = {};
  const session = {
    messages,
    agent: { state },
    subscribe: vi.fn((callback: () => void) => { listener = callback; return unsubscribe; }),
  } as unknown as AgentSession;
  const record: AgentRecord = {
    id: "focus-test", type: "general-purpose", description: "focus fixture", status: "completed",
    toolUses: 3, startedAt: 0, completedAt: 1000, compactionCount: 0,
    lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0 },
    invocation: { modelId: "test/model" }, ...opts.record,
  };
  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
    bg(_color: string, value: string) { return `\x1b[48;5;236m${value}\x1b[49m`; },
  };
  const bgSpy = vi.spyOn(theme, "bg");
  const done = vi.fn();
  const viewer = new ConversationViewer(
    tui as unknown as TUI, session, record, opts.activity, theme, done,
    opts.onStop, undefined, opts.onSteer, false, () => opts.mode ?? "assistant", opts.onMode,
  );
  return { viewer, tui, session, state, record, done, bgSpy, unsubscribe, emit: () => listener?.() };
}

function content(viewer: ConversationViewer, width = 196): string[] {
  return (viewer as unknown as { buildContentLines(width: number): string[] }).buildContentLines(width).map(line => stripTerminalSequences(line).trimEnd());
}

function output(viewer: ConversationViewer, width = 200): string {
  return viewer.render(width).map(stripTerminalSequences).join("\n");
}

function scrollState(viewer: ConversationViewer) {
  return viewer as unknown as { scrollOffset: number; autoScroll: boolean };
}

describe("ConversationViewer Focus", () => {
  it("keeps all assistant text around tool calls and later user messages, without tool noise", () => {
    const messages = [
      user("Initial task"),
      assistant([text("Before tool"), call(), text("After tool"), { type: "thinking", thinking: "private reasoning" }]),
      result(), bash, assistant([call()]), assistant([{ type: "thinking", thinking: "private reasoning" }]),
      assistant(), assistant([text(" \n ")]),
      { role: "user", content: [text("Steering task")], timestamp: 1 } satisfies Message,
      assistant([text("Final answer")]), user("Resume task"),
    ];
    const original = structuredClone(messages);
    const { viewer, session, bgSpy } = makeViewer(messages);
    const focused = content(viewer);

    expect(focused).toEqual([
      "[User]", "Initial task", "───", "[Assistant]", "Before tool", "After tool",
      "───", "✎ [Steer]", "Steering task", "───", "[Assistant]", "Final answer",
      "───", "✎ [Steer]", "Resume task",
    ]);
    expect(bgSpy).toHaveBeenCalledWith("toolPendingBg", "Steering task" + " ".repeat(196 - "Steering task".length));
    expect(output(viewer)).toContain("f focus");
    expect(output(viewer)).toContain("3 tools");
    expect(output(viewer)).toContain("1.2k token");
    expect(output(viewer)).toContain("test/model");

    viewer.handleInput("f");
    const full = content(viewer).join("\n");
    expect(output(viewer)).toContain("f full");
    for (const value of ["[Tool: private_tool]", "[Result]", "private result payload", "$ private-command", "private bash output", "Before tool", "After tool"]) {
      expect(full).toContain(value);
    }
    viewer.handleInput("f");
    expect(content(viewer)).toEqual(focused);
    expect(session.messages).toBe(messages);
    expect(messages).toEqual(original);
  });

  it("does not read hidden tool payloads or bash output while focused", () => {
    const readResult = vi.fn(() => [text("private result")]);
    const readBash = vi.fn(() => "private bash output");
    const hiddenResult = { ...result(), get content() { return readResult(); } };
    const hiddenBash = { ...bash, get output() { return readBash(); } };
    const { viewer } = makeViewer([user("task"), hiddenResult, hiddenBash]);
    expect(content(viewer)).toEqual(["[User]", "task"]);
    expect(readResult).not.toHaveBeenCalled();
    expect(readBash).not.toHaveBeenCalled();
    viewer.handleInput("f");
    content(viewer);
    expect(readResult).toHaveBeenCalled();
    expect(readBash).toHaveBeenCalled();
  });

  it("does not mistake prose resembling tool logs or reasoning for structured content", () => {
    const prose = "[Tool: read]\n[Result]\n$ echo hello\n<thinking>quoted text</thinking>";
    const { viewer } = makeViewer([user(prose), assistant([text(prose), call()])], { mode: "off" });
    const out = content(viewer).join("\n");
    expect(out.split(prose)).toHaveLength(3);
    expect(out).not.toContain("private_tool");
  });

  it("reopening defaults to Focus without changing another open viewer", () => {
    const messages = [assistant([text("answer"), call()]), result()];
    const first = makeViewer(messages).viewer;
    const second = makeViewer(messages).viewer;
    first.handleInput("f");
    expect(output(first)).toContain("f full");
    expect(output(second)).toContain("f focus");
    first.dispose();
    const reopened = makeViewer(messages).viewer;
    expect(content(reopened)).toEqual(["[Assistant]", "answer"]);
    expect(output(reopened)).toContain("f focus");
  });

  it("hides streamed tool-only updates while mixed assistant prose keeps updating", () => {
    const msg = assistant([call()], { stopReason: "toolUse" });
    const toolResult = result();
    const messages = [user("task"), msg, toolResult];
    const { viewer, tui, emit, unsubscribe } = makeViewer(messages, { record: { status: "running" } });
    const initial = content(viewer);
    expect(initial).toEqual(["[User]", "task", "", "▍ Working..."]);
    msg.content.push(call());
    toolResult.content.push(text("more private output"));
    emit();
    expect(tui.requestRender).toHaveBeenCalledOnce();
    expect(content(viewer)).toEqual(initial);
    const delta = text("First words");
    msg.content.push(delta);
    expect(content(viewer)).toContain("First words");
    delta.text += " and next words";
    emit();
    expect(content(viewer)).toContain("First words and next words");
    expect(content(viewer).join("\n")).not.toContain("private");
    viewer.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    tui.requestRender.mockClear();
    emit();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("renders uncommitted streamingMessage prose and commits it without duplicates or source mutation", () => {
    const messages = [user("task")];
    const original = structuredClone(messages);
    const { viewer, session, state, tui, emit } = makeViewer(messages, { record: { status: "running" } });
    state.streamingMessage = assistant([call(), { type: "thinking", thinking: "hidden reasoning" }]);
    const quiet = content(viewer);
    expect(quiet).toEqual(["[User]", "task", "", "▍ Working..."]);
    state.streamingMessage.content.push(call());
    emit();
    expect(content(viewer)).toEqual(quiet);

    const delta = text("Live words");
    state.streamingMessage.content.push(delta);
    emit();
    expect(content(viewer)).toEqual(["[User]", "task", "───", "[Assistant]", "Live words", "", "▍ Working..."]);
    delta.text += " before message_end";
    expect(content(viewer)).toContain("Live words before message_end");
    expect(messages).toEqual(original);
    expect(session.messages).toBe(messages);

    state.streamingMessage = assistant([text("Replacement delta"), call(), text("More prose")]);
    const stream = state.streamingMessage;
    const streamSnapshot = structuredClone(stream);
    emit();
    const streamed = content(viewer);
    expect(streamed).toContain("Replacement delta");
    expect(streamed).toContain("More prose");
    expect(streamed).not.toContain("Live words before message_end");
    expect(tui.requestRender).toHaveBeenCalledTimes(3);
    expect(state.streamingMessage).toBe(stream);
    expect(stream).toEqual(streamSnapshot);

    session.messages.push(stream);
    expect(content(viewer)).toEqual(streamed);
    state.streamingMessage = undefined;
    emit();
    expect(content(viewer)).toEqual(streamed);
    expect(content(viewer).filter(line => line === "[Assistant]")).toHaveLength(1);
    expect(session.messages).toEqual([...original, streamSnapshot]);
  });

  it("ignores stale activity text and non-assistant streaming messages", () => {
    const activity: AgentActivity = { activeTools: new Map(), responseText: "stale previous answer", toolUses: 1, turnCount: 2 };
    const { viewer, state } = makeViewer([user("new task")], { activity, record: { status: "running" } });
    for (const msg of [undefined, assistant(), assistant([call()]), result(), bash, user("uncommitted user")]) {
      state.streamingMessage = msg;
      expect(content(viewer)).toEqual(["[User]", "new task", "", "▍ Working..."]);
    }
  });

  it("renders in-flight prose in the selected Markdown mode and follows streamed line growth", () => {
    const { viewer, state } = makeViewer([user("task")], { rows: 20, record: { status: "running" } });
    const delta = text("# Live heading");
    state.streamingMessage = assistant([delta, call()]);
    expect(content(viewer)).toContain("Live heading");
    viewer.handleInput("m");
    viewer.handleInput("m");
    expect(content(viewer)).toContain("# Live heading");
    output(viewer);
    delta.text += "\n" + Array.from({ length: 40 }, (_, i) => `streamed line ${i}`).join("\n");
    expect(output(viewer)).toContain("streamed line 39");
    expect(scrollState(viewer).scrollOffset).toBe(content(viewer).length - 7);
    viewer.handleInput("f");
    viewer.handleInput("f");
    expect(output(viewer)).toContain("streamed line 39");
    expect(output(viewer)).toContain("f focus · m raw");
  });

  it("shows in-flight terminal failures and deduplicates the record error", () => {
    const { viewer, state, record } = makeViewer([], { record: { status: "error" } });
    state.streamingMessage = assistant([call()], { stopReason: "error", errorMessage: "stream failed" });
    expect(content(viewer)).toEqual(["[Error]", "stream failed"]);
    record.error = "stream failed";
    expect(content(viewer)).toEqual(["[Error]", "stream failed"]);
  });

  it("uses generic activity, retains full activity and never mutates its tracker", () => {
    const activity: AgentActivity = {
      activeTools: new Map([["private arguments", "private_tool"]]),
      responseText: "private bash output", toolUses: 7, turnCount: 1,
    };
    const original = structuredClone(activity);
    const { viewer } = makeViewer([user("task")], { activity, record: { status: "running" } });
    expect(content(viewer)).toContain("▍ Working...");
    expect(output(viewer)).toContain("7 tools");
    expect(output(viewer)).not.toContain("private");
    viewer.handleInput("f");
    expect(content(viewer)).toContain("▍ private_tool…");
    viewer.handleInput("f");
    expect(activity).toEqual(original);
    activity.activeTools.clear();
    expect(content(viewer)).toContain("▍ Working...");
    expect(content(viewer).join("\n")).not.toContain("private bash output");
    viewer.handleInput("f");
    expect(content(viewer)).toContain("▍ private bash output");
  });

  it.each(["running", "queued", "completed"] as const)("gives an honest textless placeholder when %s", status => {
    for (const messages of [[], [assistant(), assistant([call()]), assistant([{ type: "thinking", thinking: "hidden" }]), result(), bash]]) {
      const { viewer } = makeViewer(messages, { record: { status } });
      const lines = content(viewer);
      expect(lines[0]).toBe(status === "completed" ? "(no conversation text to display)" : "(waiting for conversation text...)");
      expect(lines).not.toContain("[Assistant]");
      expect(lines).not.toContain("───");
    }
  });

  it("shows terminal provider failures once, including partial prose, not failed-tool logs", () => {
    const failure = "Provider unavailable";
    const { viewer } = makeViewer([
      assistant([], { stopReason: "error", errorMessage: failure }), result(),
      assistant([text("Partial answer")], { stopReason: "error", errorMessage: ` ${failure} ` }),
    ], { record: { status: "error", error: failure } });
    expect(content(viewer)).toEqual(["[Assistant]", "Partial answer", "───", "[Error]", failure]);
    expect(output(viewer)).toContain("✗");
    viewer.handleInput("f");
    expect(content(viewer).filter(line => line === failure)).toHaveLength(1);
  });

  it.each([
    { stopReason: "error", expected: "Provider error (no details)." },
    { stopReason: "aborted", expected: "Assistant response aborted." },
    { stopReason: "stop", errorMessage: "Explicit provider error", expected: "Explicit provider error" },
  ] as const)("shows terminal $stopReason diagnostics without empty assistant headers", ({ stopReason, expected, ...rest }) => {
    const { viewer } = makeViewer([assistant([], { stopReason, errorMessage: "errorMessage" in rest ? rest.errorMessage : undefined })]);
    expect(content(viewer)).toEqual(["[Error]", expected]);
  });

  it("shows record-only errors even with no session messages", () => {
    const { viewer } = makeViewer([], { record: { status: "error", error: "Agent startup failed" } });
    expect(content(viewer)).toEqual(["[Error]", "Agent startup failed"]);
  });

  it("preserves distinct record and provider errors", () => {
    const { viewer } = makeViewer([assistant([], { stopReason: "aborted", errorMessage: "Request cancelled" })], {
      record: { status: "error", error: "Agent cleanup failed" },
    });
    expect(content(viewer)).toContain("Request cancelled");
    expect(content(viewer)).toContain("Agent cleanup failed");
  });

  it("does not repeat old provider errors after a successful reply or resume prompt", () => {
    const failure = assistant([], { stopReason: "error", errorMessage: "Old failure" });
    for (const next of [assistant([text("Recovered")]), user("Resume now")]) {
      const { viewer } = makeViewer([failure, next]);
      expect(content(viewer).join("\n")).not.toContain("Old failure");
    }
  });

  it("keeps Markdown modes independent from Focus and displays both footer modes", () => {
    const onMode = vi.fn();
    const { viewer } = makeViewer([assistant([text("# Heading"), call()]), result("# Result")], { onMode });
    expect(output(viewer, 80)).toContain("f focus · m md");
    expect(content(viewer)).toContain("Heading");
    viewer.handleInput("m");
    expect(onMode).toHaveBeenLastCalledWith("all");
    expect(output(viewer, 80)).toContain("f focus · m md+");
    expect(content(viewer)).not.toContain("Result");
    viewer.handleInput("f");
    expect(output(viewer, 80)).toContain("f full · m md+");
    expect(content(viewer)).toContain("Result");
    expect(onMode).toHaveBeenCalledTimes(1);
    viewer.handleInput("m");
    expect(content(viewer)).toContain("# Heading");
    expect(content(viewer)).toContain("# Result");
    viewer.handleInput("f");
    expect(output(viewer, 80)).toContain("f focus · m raw");
    expect(content(viewer)).toContain("# Heading");
    expect(content(viewer)).not.toContain("# Result");
  });

  it("routes f/m/x literally to steering input and preserves Enter and Esc behavior", () => {
    const onSteer = vi.fn();
    const onMode = vi.fn();
    const onStop = vi.fn();
    const { viewer, done } = makeViewer([], { record: { status: "running" }, onSteer, onMode, onStop });
    viewer.handleInput("\r");
    for (const ch of "fmxx") viewer.handleInput(ch);
    expect(output(viewer, 80)).toContain("fmxx");
    viewer.handleInput("\r");
    expect(onSteer).toHaveBeenCalledWith("fmxx");
    expect(onMode).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(output(viewer, 80)).toContain("f focus · m md");
    viewer.handleInput("\r");
    viewer.handleInput("f");
    viewer.handleInput("\x1b");
    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    viewer.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
  });

  it("f disarms stop, requests render, and leaves double-confirm functional", () => {
    const onStop = vi.fn();
    const { viewer, tui } = makeViewer([], { record: { status: "running" }, onStop });
    viewer.handleInput("x");
    expect(output(viewer, 80)).toContain("x again to STOP");
    tui.requestRender.mockClear();
    viewer.handleInput("f");
    expect(tui.requestRender).toHaveBeenCalledOnce();
    expect(output(viewer, 80)).toContain("x stop");
    viewer.handleInput("x");
    expect(onStop).not.toHaveBeenCalled();
    viewer.handleInput("x");
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("counts filtered lines for scrolling and resets safely to follow the end on toggle", () => {
    const prose = assistant([text(Array.from({ length: 40 }, (_, i) => `prose ${i}`).join("\n"))]);
    const messages = [user("task"), result("log\n".repeat(1000)), prose];
    const { viewer } = makeViewer(messages, { rows: 20 });
    output(viewer);
    const viewport = 7; // 70% of 20 rows minus 7 chrome rows (including model metadata).
    const bottom = content(viewer).length - viewport;
    expect(scrollState(viewer).scrollOffset).toBe(bottom);
    expect(output(viewer)).toContain(`${content(viewer).length} lines · 100%`);
    viewer.handleInput("k");
    expect(scrollState(viewer).scrollOffset).toBe(bottom - 1);
    expect(scrollState(viewer).autoScroll).toBe(false);
    viewer.handleInput("\x1b[5~");
    expect(scrollState(viewer).scrollOffset).toBe(bottom - 1 - viewport);
    viewer.handleInput("\x1b[H");
    expect(scrollState(viewer).scrollOffset).toBe(0);
    viewer.handleInput("f");
    expect(scrollState(viewer).scrollOffset).toBe(content(viewer).length - viewport);
    expect(scrollState(viewer).autoScroll).toBe(true);
    viewer.handleInput("k");
    viewer.handleInput("f");
    expect(scrollState(viewer).scrollOffset).toBe(bottom);
    expect(scrollState(viewer).autoScroll).toBe(true);
    prose.content.push(text("latest prose"));
    expect(output(viewer)).toContain("latest prose");
    expect(scrollState(viewer).scrollOffset).toBe(content(viewer).length - viewport);
    viewer.handleInput("\x1b[H");
    viewer.handleInput("\x1b[F");
    expect(output(viewer)).toContain("latest prose");
  });

  it("toggles before first render and clamps from long full logs to a short focused transcript", () => {
    const { viewer } = makeViewer([user("tiny task"), result("log\n".repeat(1000))], { rows: 20 });
    viewer.handleInput("f");
    expect(scrollState(viewer).scrollOffset).toBe(0);
    output(viewer);
    expect(scrollState(viewer).scrollOffset).toBeGreaterThan(900);
    viewer.handleInput("k");
    viewer.handleInput("f");
    expect(scrollState(viewer).scrollOffset).toBe(0);
    expect(output(viewer)).toContain("tiny task");
    viewer.handleInput("j");
    expect(scrollState(viewer).scrollOffset).toBe(0);
  });

  it.each([6, 8, 20, 40, 80, 120, 216])("keeps focused/full rows and errors within width %i", width => {
    const { viewer } = makeViewer([
      user("task"), assistant([text(`日本語 **bold** ${"界".repeat(200)}`), call()]),
      result("\x1b[31m" + "output ".repeat(400) + "\x1b[0m"), bash,
    ], { record: { status: "error", error: "Provider error " + "界".repeat(400) } });
    for (const mode of ["focus", "full"]) {
      expect(output(viewer, 216)).toContain(`f ${mode}`);
      for (const line of viewer.render(width)) expect(visibleWidth(line)).toBe(width);
      for (const line of content(viewer, width - 4)) expect(visibleWidth(line)).toBeLessThanOrEqual(width - 4);
      viewer.handleInput("f");
    }
  });
});
