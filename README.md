<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:02100a,100:2fe07a&height=160&section=header&text=wevibe-opencode-plugin&fontColor=54f59a&fontSize=42&fontAlignY=40&desc=OpenCode%20integration%20for%20WeVibe%20memory&descAlignY=64&descSize=16" alt="wevibe-opencode-plugin" width="100%" />

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
[![status-alpha](https://img.shields.io/badge/status-alpha-ffc266?style=flat-square)](https://github.com/WeVibe-Network)
[![license-Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-82aaff?style=flat-square)](LICENSE)
[![docs-wevibe-docs](https://img.shields.io/badge/docs-wevibe--docs-54f59a?style=flat-square)](https://github.com/WeVibe-Network/wevibe-docs)
[![%40WeVibe__Network](https://img.shields.io/badge/%40WeVibe__Network-0a0a0a?style=flat-square&logo=x&logoColor=white)](https://x.com/WeVibe_Network)

</div>

---

OpenCode plugin integration for WeVibe memory retrieval, review, and injection.

## Overview

`wevibe-opencode-plugin` is a TypeScript plugin package focused on OpenCode.

Current alpha implementation:

- Exports `WeVibeMemoryPlugin` from `plugins/wevibe-plugin.ts`.
- Includes a TUI companion in `plugins/wevibe-plugin-tui.tsx` for memory review dialogs.
- Manages moderation queue/state files in the active worktree under `.opencode/`.
- Uses the local `wevibe-mcp` loopback API for recall, reports, denials, and serve-event forwarding.
- Forwards serve events with matched keywords back through MCP/hub reporting paths.
- Writes operational plugin diagnostics to `wevibe-plugin-errors.log`.

## Role in the WeVibe Network

This repository owns the OpenCode integration surface.

It connects the coding session to local WeVibe controls by:

1. Pulling recalled memory candidates from local `wevibe-mcp`.
2. Enforcing human review decisions (accept, deny, report) through local moderation queues.
3. Injecting only approved memory into the agent context.
4. Sending serve/report/denial events back to MCP and hub services.

## Getting started

### Prerequisites

- Node.js
- npm
- OpenCode runtime with plugin loading enabled
- Local `wevibe-mcp` instance reachable on loopback

### Build

```bash
npm install
npm run build
```

(`npm run build` and `npm run typecheck` both run `tsc --noEmit`.)

### Run

This package is loaded as an OpenCode plugin rather than run as a standalone daemon.

- Main plugin entry: `plugins/wevibe-plugin.ts`
- TUI plugin entry: `plugins/wevibe-plugin-tui.tsx`

## Testing

There is no standalone automated test script in this repository yet.

Current validation flow is type-check based:

```bash
npm run typecheck
```

## Configuration

Environment variables used by the plugin:

- `WEVIBE_HUB_URL` — hub base URL used for moderation/reporting flows.
- `WEVIBE_ORG_ID` — org ID for serve/report/denial payloads.
- `WEVIBE_PLUGIN_DEBUG=1` — enables verbose plugin stderr output.
- `WEVIBE_ROOT` — optional workspace-root override for locating `wevibe-mcp`.

Local integration assumptions:

- Local MCP HTTP endpoint: `http://127.0.0.1:4450`
- MCP Bearer token file: `~/.wevibe/mcp-session-token`
- Local policy config: `~/.wevibe/plugin-config.json`
- Queue files: `.opencode/wevibe-plugin-queue.json`, `.opencode/wevibe-plugin-decisions.json`, `.opencode/wevibe-plugin-status.json`

## Roadmap

See [ROADMAP.md](./ROADMAP.md).

## License

Apache-2.0.

## Links

- Docs: https://github.com/WeVibe-Network/wevibe-docs
- Org: https://github.com/WeVibe-Network
- X: https://x.com/WeVibe_Network
