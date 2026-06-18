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

Reason: the engine plugin is the **sole** `:4450` MCP spawner because it provides the correct `WEVIBE_UMBRAL_SIDECAR_BIN` and `WEVIBE_GUARD_BIN` environment. A second opencode-spawned env-less MCP process would break leader-side Umbral crypto.

## Reference template in this repo

`tui.json` in this repo is a template:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["./tui/wevibe.tsx", {}]]
}
```

The installer writes the actual machine-specific `adminScript` option into the user config at install time.
