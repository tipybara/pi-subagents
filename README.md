# pi-subagents (local fork)

Local fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) **0.17.1** with small TUI/UX customizations.

Full upstream documentation: **[original_readme.md](./original_readme.md)**

## Custom behavior

| Area | Customization |
|------|----------------|
| **FleetView keys** | `Ctrl+N` / `Ctrl+P` activate and move selection alongside arrows; only while prompt is empty. |
| **Fleet / widget labels** | Task description primary; agent type secondary (`description · type`). |
| **`Agent(...)` tool UI** | Compact self-render shell: `⏺ Agent(desc · type)`, without colored tool-box background. |
| **`steer_subagent` UI** | Distinct `✎ Steer(...)` call/result rendering. |
| **Conversation viewer steers** | Later user messages render as `✎ [Steer]` with full-width `toolPendingBg` wash. |
| **Theme Proxy safety** | Background paint calls `th.bg(...)` as bound method, required by pi Theme Proxy. |

## Preserved upstream behavior

- Agent color badges and selected-row styling
- Background-by-default agents and background resume
- `@handle` mentions and nested delegation
- Worktree isolation controls
- `output_transcript`, abortable waits, foreground outcome notes
- `PI_CODING_AGENT_DIR` memory scope and extension tool scope

## Updating from upstream

1. Rebase onto latest upstream.
2. Re-check custom table, especially bound `th.bg(...)`.
3. Run `npm test && npm run typecheck && npm run build`.

## Develop

```bash
npm install
npm test
npm run typecheck
npm run build
```
