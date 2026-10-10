# Plan: a built-in proxy instead of CLIProxyAPI

Status: planned, not started. First make the CLIProxyAPI version (`inscope proxy`, PR #61) work.

## Why

`inscope proxy` downloads and runs a second app (CLIProxyAPI) under launchd. That is an external binary to pin, verify, and keep running, while inscope itself has zero runtime dependencies. inscope only uses a small part of CLIProxyAPI, so building that part into inscope would remove the dependency.

## What inscope would need to build (zero-dep: `node:http` + `fetch`)

- A loopback-only server (`127.0.0.1`) that checks a client key from the Keychain.
- Claude OAuth sign-in (PKCE), kept user-driven: inscope opens Anthropic's sign-in page in a fresh Chrome profile and the user signs in, as `inscope login` does today. Plus token refresh.
- Routing:
  - fill-first, with session affinity on `x-claude-code-session-id`;
  - on a 429, retry the same request on the next account at once, so the conversation carries on.
- Streaming (SSE) passthrough for `/v1/messages`, plus `/v1/messages/count_tokens` and `/v1/models`.
- Undated model ids (e.g. `claude-haiku-4-5`) mapped onto the dated ones.

## Keep

- The workspace gateway (`ANTHROPIC_BASE_URL` + Keychain `apiKeyHelper`), so the
  switch is internal to inscope.
- The command surface from `proxy-first.md`: one `inscope login`, with
  `inscope proxy status/start/stop/setup/uninstall` as low-level controls (no
  separate `proxy login`).
- The test approach: a Messages API emulator on vercel-labs/emulate, plus a real
  `claude` CLI run through the proxy.

## Risks to weigh first

- **Maintenance.** CLIProxyAPI tracks Anthropic's wire changes for OAuth requests, such as the Claude Code fingerprint, the signed billing header and beta headers. A built-in proxy inherits that work.
- **Terms.** Nothing changes here: it still stores and forwards Claude.ai credentials, which Anthropic's terms forbid for third parties. Running it stays the user's choice and risk.
