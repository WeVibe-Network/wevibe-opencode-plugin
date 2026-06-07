## Status

`wevibe-opencode-plugin` is in alpha and focused on OpenCode integration.

Current delivered functionality includes:

- OpenCode plugin entrypoint (`plugins/wevibe-plugin.ts`) with local MCP wiring.
- TUI review workflow (`plugins/wevibe-plugin-tui.tsx`) for approve/deny/report decisions.
- Local moderation queues and status tracking in `.opencode/` files.
- Serve, report, and denial event forwarding through the local MCP/hub path.

## Near-term

- Improve reliability and observability of queue processing and review-state transitions.
- Tighten onboarding ergonomics for OpenCode users (configuration clarity and startup diagnostics).
- Continue hardening serve/report payload handling with stricter validation and clearer operator feedback.

## Future

- Keep this repository centered on OpenCode integration quality and compatibility as the OpenCode plugin API evolves.
- Cross-agent plugin expansion (for example Claude Code, Cursor, and Cline) is tracked in the `wevibe-mcp` roadmap and related network planning docs.

## Design references

- WeVibe docs repository: https://github.com/WeVibe-Network/wevibe-docs
