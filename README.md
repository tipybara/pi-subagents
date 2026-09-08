# pi-subagents (local fork)

Local fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) **0.19.0**, integrated through `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`.

Full upstream reference: **[original_readme.md](./original_readme.md)**. Native workflow guide: **[docs/workflows.md](./docs/workflows.md)**.

## Custom behavior

| Area | Customization |
|------|---------------|
| FleetView | One rounded Subagents card below the editor, with workflow runs above ordinary agents. No `main` row. |
| Keyboard | Empty input: Down / Ctrl+N selects the first row. Enter opens an agent conversation or the workflow inspector. Esc returns to input. With the dotfiles bottom navigator, continue down into footer statuses. |
| Labels | Elapsed clock, task description first, agent type second, and live phase. Optional cost display retains upstream's record-based token/cost accounting. |
| Agent tool UI | Compact description-first self-render shell, without a colored tool-box background. |
| Steer UI | Distinct Steer tool label; later viewer user messages keep the full-width `toolPendingBg` wash. |
| Conversation viewer | Focus by default: user prompts, steers, live assistant prose and terminal errors; tool calls/results, bash execution and reasoning-only messages stay hidden. `f` toggles full logs (`f focus` / `f full` shows current mode), returning to the end. `m` independently cycles raw / Markdown / Markdown+. |
| Theme safety | Background paint calls `th.bg(...)` as a bound method. |

The above-editor widget remains available upstream-style, but the portable config sets `widgetMode: "off"` to prevent duplicate cards. FleetView stays enabled independently.

Viewer Focus is local to each open viewer, independent of main Focus and Markdown settings; reopening defaults to Focus. Full transcripts and tool activity remain unchanged, including existing full-view truncation limits. Focus shows generic `Working...` while running. `Enter` opens steering input (shortcut letters type literally there); `x` twice stops, `Esc` closes.

## Unified workflows

Use `Agent` for direct delegation and `SubagentWorkflow` for scripted `agent()`, `parallel()`, and `pipeline()` orchestration. They share the same AgentManager. Enter on a workflow row opens its inspector; `c` inside that inspector opens a child's conversation. Workflow-owned children do not appear again as ordinary fleet rows.

The standalone `@quintinshaw/pi-dynamic-workflows` extension is not required. This is not an API-compatible replacement for every helper it provided: `workflow_control`, its built-in named patterns, `judgePanel`, and token-budget options do not carry over automatically. Saved native scripts use the contract in `docs/workflows.md`.

Do not reload while a native workflow is running. Its run registry and resume journal are session-scoped; old dynamic-workflows histories remain separate archives, not native resumable runs.

## Updating

Preserve the local diff before merging upstream, especially FleetView keyboard ownership and the bound theme calls. No automatic publishing or force pushes.

```bash
npm ci
npm run check
npm run test:e2e
npm run build
```
