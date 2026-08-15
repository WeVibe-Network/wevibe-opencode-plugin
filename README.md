# wevibe-opencode-plugin

Self-contained OpenCode plugin package for WeVibe integration.

## Architecture

OpenCode does **not** allow one module to be both an engine plugin and a TUI plugin (`@opencode-ai/plugin` defines `TuiPluginModule = { tui, server?: never }`).

So this repo intentionally ships two modules that act as one integration:

- **Engine plugin**: `plugins/wevibe-plugin.ts` (registered in `opencode.json`)
- **TUI popup plugin**: `tui/wevibe.tsx` (registered in `tui.json`)

They coordinate through local `.opencode/` state files (queue, decisions, heartbeat).

## Runtime dependency on wevibe-mcp

The TUI module calls `wevibe-mcp/dist/admin.js` at runtime for identity and pairing operations.

That dependency is intentional: runtime crypto remains in `wevibe-mcp`. The installer writes the machine-specific absolute `adminScript` path into `~/.config/opencode/tui.json`.

## Install / uninstall

Use package scripts:

```bash
npm run install-opencode
npm run uninstall-opencode
```

Or run directly:

```bash
npx tsx bin/install-opencode.ts install-opencode
npx tsx bin/install-opencode.ts uninstall-opencode
```

Supported flags:

- `--config-dir`
- `--node`
- `--engine-path`
- `--mcp-dir`
- `--force`
- `--json`

## Important MCP wiring behavior

`install-opencode` writes `mcp.wevibe` with `enabled: false` on purpose.

Reason: the engine plugin is the **sole** `:4450` MCP spawner because it provides the correct `WEVIBE_GUARD_BIN` environment, and because two processes must not contend for the same port.

Note: this is no longer an Umbral concern. Umbral crypto ships as WASM inside `wevibe-mcp` and works in any process regardless of environment, so an opencode-spawned MCP no longer breaks leader-side crypto — it would only collide on the port.

## Configuration

`~/.wevibe/plugin-config.json` supports `inject_char_budget` for memory injection budgeting:

- default: `8000` chars (roughly ~2k tokens at ~4 chars/token)
- bounds the session's total injected memory block size
- memories that would exceed remaining budget are skipped for that session and logged as `[inject] over_budget`

## Reference template in this repo

`tui.json` in this repo is a template:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["./tui/wevibe.tsx", {}]]
}
```

The installer writes the actual machine-specific `adminScript` option into the user config at install time.
