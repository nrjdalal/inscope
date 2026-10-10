# Plan: the proxy is the product (one login, always behind the proxy)

Status: direction agreed (2026-10-10). It lands after #56 and #61, which merge as
they are; this redesign is the next PR.

## Direction

There is one sign-in, `inscope login`, and no separate `inscope proxy login`. Every
Claude account inscope manages lives in the proxy, and Claude Code always reaches
Anthropic through it, even with a single account. Rotation, pools, and usage all
come from that one place.

## Shape (proposed)

- `inscope login`: signs a Claude account into the proxy. The user signs in, in a
  fresh Chrome profile, with nothing pre-filled. The first login installs and starts
  the proxy itself, so there is no setup step first (`proxy setup` remains only to
  reinstall it or move its port).
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

## Decided

- The shared login goes through the proxy too: everything does. inscope has to route
  `~/.claude` as well (through the shell hook or its settings), and that session also
  loses claude.ai connectors and Remote Control.

## Open questions

- Keep CLIProxyAPI for now, or go straight to a built-in proxy (`native-proxy.md`)?

## Implementation (PR: feat/proxy-first)

Named accounts (#60), the gateway (#56), and the proxy (#61) have only shipped in
canary builds (`0.18.0-canary.*`), never in a release, so they can be reshaped freely.

1. **One sign-in.**
   - `inscope login [--email <e>] [--browser chrome|system|none]` sets up the proxy
     on first use: install, Keychain key, config, launchd, health check, and a
     one-time terms note. It then runs the proxy's Claude sign-in, then `apply`.
   - `inscope logout <email>` removes an account from the proxy.
   - `proxy login` and `proxy logout` go away. `inscope proxy setup [--port]` stays
     as a low-level re-install or port change; `proxy status`, `start`, `stop`, and
     `uninstall` stay as they are.
2. **Everything behind the proxy.** While `proxy` is configured, `apply` writes
   `env.ANTHROPIC_BASE_URL` plus the Keychain `apiKeyHelper`:
   - into the base login's `settings.json` (`$INSCOPE_BASE_CCD`, else
     `~/.claude`), with only inscope's own keys touched;
   - into every isolated workspace's `.inscope/settings.json`.

   Without a proxy, apply clears inscope's keys from both. `add --proxy` /
   `--no-proxy` go away, and so does the workspace `gateway` field (decided during
   the build: one path, everything through the proxy; routing a workspace elsewhere
   becomes a pool setting, see `per-workspace-pools.md`). A config that still has a
   `gateway` loads with it dropped, and a note unless it was the proxy's own URL.

3. **Named accounts retired.** This removes:
   - `accounts` and workspace `account` in the config;
   - `add --account`;
   - the per-account dirs and the hook arms for them;
   - the per-account bypass and the `claude auth login` flow.

   A config that still has them loads with them dropped, plus a one-time note
   listing the emails to sign in with `inscope login`. The old dirs are left in
   place, with a hint.

4. **Isolation keeps its meaning:** a workspace's own config dir, for its history,
   settings, and skills. With the proxy it needs no sign-in, so status, doctor, and
   add stop asking for one.
5. **`inscope usage`** lists the proxy's accounts (email, plan, 5-hour, weekly),
   reading each account's token from its auth file. The plan comes from the
   profile endpoint's `rate_limit_tier`.
6. **`doctor`** checks:
   - the proxy (already done);
   - the base login's routing, configured but not applied, or stale after the
     proxy is removed;
   - each isolated login's routing.
7. **Tests.**
   - CLI `login`/`logout` against a stand-in proxy binary, plus fake `launchctl`,
     `security`, and Chrome on PATH. The real launchd and Keychain are never
     touched.
   - The health check is answered by the Messages emulator.
   - Settings goldens for the base login.
   - The real-proxy failover test stays.
8. **Real run on the Mac.**
   - Back up `~/.claude/settings.json` first.
   - `inscope login` signs in one more account, and `apply` routes the shared login.
   - A real `claude -p` from a plain directory and from an isolated workspace.
   - `usage`, `doctor`, and `status`, with screenshots on the PR.
