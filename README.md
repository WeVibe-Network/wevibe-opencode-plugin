# wevibe-opencode-plugin

OpenCode integration for the WeVibe network memory layer. It pulls recalled memories from a local `wevibe-mcp`, puts them in front of a human, and injects only the ones that human approves.

WeVibe's core claim is that no memory enters an agent's context without human eyes on it first. That guarantee is structural here, not aspirational: the only injection path in the system is this plugin's `experimental.chat.system.transform` hook, and that hook blocks on a four-button human review gate before it injects anything. There is no approved-less code path to design around — an unreviewed memory simply cannot reach the system prompt.

Status: alpha. The loop works end to end, but interfaces and defaults still move.

## Architecture: two modules, one integration

OpenCode does not allow one module to act as both an engine plugin and a TUI plugin (`@opencode-ai/plugin` defines `TuiPluginModule = { tui, server?: never }`). So this repo ships two modules deliberately:

- **Engine plugin** — `plugins/wevibe-plugin.ts`, registered in OpenCode's `opencode.json`. Owns recall, the injection hook, failure observation, and evidence emission.
- **TUI popup** — `tui/wevibe.tsx`, registered in OpenCode's `tui.json`. Renders the review queue and captures human decisions.

The two never import each other. They coordinate only through JSON files in a shared state directory: the review queue, decisions, status snapshot, and a heartbeat. The TUI polls the queue every 5 s and writes a heartbeat; the engine considers the TUI live only while that heartbeat is fresh.

The TUI module additionally calls `wevibe-mcp/dist/admin.js` at runtime for identity and pairing. That dependency is intentional: runtime crypto stays in `wevibe-mcp`. The installer writes the machine-specific absolute `adminScript` path into your OpenCode `tui.json`.

## Install / uninstall

```bash
npm run install-opencode
npm run uninstall-opencode
```

Or directly: `npx tsx bin/install-opencode.ts install-opencode` (same for `uninstall-opencode`). Supported flags: `--config-dir`, `--node`, `--engine-path`, `--mcp-dir`, `--force`, `--json`.

Install also registers a `mcp.wevibe` entry with `enabled: false`. That is deliberate — see below.

## Runtime dependency on wevibe-mcp

The engine talks to a local `wevibe-mcp` over loopback only (`http://127.0.0.1:4450`, overridable via `WEVIBE_MCP_HTTP_URL`): `POST /v1/recall` for candidates, plus serve receipts and outcome events.

The engine plugin is the SOLE spawner of that MCP in the OpenCode-managed path. If `:4450` is not up, it starts `wevibe-mcp/dist/server.js` itself, with the correct environment, and captures the child's output to a log file. This is why the installed `mcp.wevibe` entry is disabled: a second, environment-less spawner on the same port must not exist.

Sessions bind to an organization only through a `.wevibe` marker at the session's spawn root (the directory OpenCode launched in). No parent walk, no subdirectory descent, no marker at the spawn root means the session stays dormant and does nothing on the network.

## The recall loop

1. **Trigger.** Recall never fires on user prompts. The engine watches bash output for live build/test failures. The first failure under a stable `failureKey` (binding fingerprint + predicate + failing test/command identity) opens an episode; recall fires on the SECOND failure under the same key, and only if a file edit happened between the two reds (a flake guard against retry-without-change loops).
2. **Gate.** Recalled candidates land in the TUI review queue. The injection hook blocks until every candidate is decided: **Accept**, **Deny**, **Block** (deny and blacklist), or **Report** (with reason). There is no timeout and no fallthrough — the only exit without a human decision is a dead TUI (heartbeat stale). Bench-only exceptions: a scripted answerer (`WEVIBE_ANSWERER_POLICY`) and test-mode governor defaults.
3. **Inject.** Approved memories are injected once per session, as a single block spliced into the system prompt at index 1 (immediately after the system instructions), within a fixed character budget: default 8000 chars (~2k tokens), configurable via `inject_char_budget` in `~/.wevibe/plugin-config.json`. Over-budget memories are skipped and logged, not truncated.
4. **Compaction.** When OpenCode compacts the session, the `experimental.session.compacting` hook re-inserts the injected block verbatim. Approved memory is never summarized away.
5. **Evidence.** Every serve and every outcome is POSTed back to the MCP as signed-evidence material (serve receipts with episode pairing, plus observed outcomes), feeding the organization's on-chain record.

## What this plugin does NOT do

- It does not extract, submit, or curate memories. Contributions and review pipelines are dashboard- and MCP-driven.
- It does not recall per prompt and has no ambient always-on injection.
- It does not run Umbral as a sidecar. Umbral crypto ships as in-process WASM inside `wevibe-mcp`.
- It never injects a memory that no human decided on. If the gate is unavailable, nothing is injected.

## What is genuinely unique here

- **Repeat-failure trigger** — recall fires on the second failure under a stable key, never per prompt, so memory demand is tied to real stuckness.
- **The one blocking gate** — the only hook allowed to block a turn, with no timeout: human review is a hard structural barrier, not a best effort.
- **Verbatim compaction restore** — approved memory survives context compaction exactly as injected.
- **Dual evidence machinery** — serve receipts and outcome events close the loop between what was injected and what it did.
- **Harvest-rich recall** — the query carries harvested local signals (intent, task, language, stack, frameworks, deps, error strings, files, live build/test state).
- **Spawn-root-only binding** — org binding is decided solely by the marker where the session started; nothing else activates the plugin.

## Repository layout

- `plugins/` — engine plugin and its observation/evidence modules, with tests.
- `tui/` — TUI popup built on `@opentui` + Solid.
- `bin/install-opencode.ts` — installer/uninstaller for OpenCode configs.
- `tui.json` — reference template; the installer writes machine-specific values into your real config.

## License

Apache-2.0. See `SECURITY.md` for vulnerability reports and `CONTRIBUTING.md` for contributions.
