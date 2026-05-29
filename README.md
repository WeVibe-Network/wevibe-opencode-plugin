# wevibe-opencode-plugin

Part of [WeVibe Network](https://github.com/WeVibe-Network).

This repository is being initialized as part of Sprint 28. Full
content lands in subsequent change orders (CO-282 through CO-285).

## Plugin Overview

- `WeVibeMemoryPlugin` is exported from `plugins/wevibe-plugin.ts` and registered with OpenCode via `wevibe-plugin-tui.tsx`.
- The plugin manages moderation queues backed by `.opencode/wevibe-plugin-queue.json`, `.opencode/wevibe-plugin-decisions.json`, and `.opencode/wevibe-plugin-status.json` inside the active worktree.
- Errors and warnings are appended to `wevibe-plugin-errors.log` under the detected WeVibe workspace root (or the current working directory).

### Serve keyword threading (CO-033b)

The plugin now carries `matched_keywords` end-to-end on serve reporting:

1. Reads `matched_keywords` from hub recall memory results.
2. Stores them on the in-memory injection records (`toInject`).
3. Sends them to MCP `POST /v1/serves` with each serve event payload.

This keeps plugin serve reports aligned with the strict hub/chain requirement that `matched_keywords` must be present and non-empty.

## Environment

- `WEVIBE_HUB_URL` — base URL for the WeVibe Hub; required for filing moderation reports.
- `WEVIBE_ORG_ID` — organization identifier used when submitting reports to the hub.
- `WEVIBE_PLUGIN_DEBUG=1` — enables verbose stderr logging with the `wevibe(<level>)` prefix.
- `WEVIBE_ROOT` — optional override for locating the monorepo when auto-discover fails.
- `WEVIBE_AUTO_CONTRIBUTE=1` and `WEVIBE_ALLOW_UNREVIEWED=1` are set automatically when the plugin spawns `wevibe-mcp`.

The plugin also reads `~/.wevibe/plugin-config.json` for the risk appetite (`lowest` or `neutral`) and `~/.wevibe/mcp-session-token` for authenticating with the local MCP service.

## Development

- Install dependencies with `npm install`.
- Type-check with `npm run typecheck` (alias: `npm run build`).
- The OpenCode package entry point is `plugins/wevibe-plugin.ts`.

## License

Apache-2.0. See LICENSE in the populated version.
