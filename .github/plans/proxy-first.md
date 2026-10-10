# Plan: the proxy is the product (one login, always behind the proxy)

Status: direction agreed with the user (2026-10-10); design to settle before building.

## Direction

There is one sign-in, `inscope login`, and no separate `inscope proxy login`. Every
Claude account inscope manages lives in the proxy, and Claude Code always reaches
Anthropic through it, even with a single account. Rotation, pools, and usage all
come from that one place.

## Shape (proposed)

- `inscope login`: signs a Claude account into the proxy. The user signs in, in a
  fresh Chrome profile, with nothing pre-filled. The first login installs and starts
  the proxy itself, so there is no separate `proxy setup` step.
- Workspaces route through the proxy by default (`ANTHROPIC_BASE_URL` plus a
  Keychain `apiKeyHelper`). A workspace picks which accounts serve it (see
  `per-workspace-pools.md`); the default is all of them.
- `inscope usage` lists the proxy's accounts. `inscope proxy status/start/stop`
  stay as low-level controls.
- The named-account logins from #60 (one `CLAUDE_CONFIG_DIR` per account) are
  replaced by proxy accounts. Existing accounts are signed in again; their tokens
  are not copied over.

## Costs to weigh

- Behind a non-Anthropic base URL, Claude Code disables Remote Control and claude.ai
  connectors, and turns MCP tool search off by default. With the proxy everywhere,
  that applies to every session, not just pooled ones.
- If the proxy is down, Claude Code cannot reach Anthropic at all. `doctor` and the
  launchd keep-alive have to make that rare and obvious.
- Anthropic's terms forbid third parties that store or relay Claude.ai credentials.
  With the proxy always on, that applies to every account, including a single one.
- The shared login (`~/.claude`): inscope never writes it today. Routing it through
  the proxy needs either that write or the hook exporting the base URL and key.

## Open questions

- The shared login: route it through the proxy, or leave it direct?
- Keep CLIProxyAPI for now, or go straight to a built-in proxy (`native-proxy.md`)?
