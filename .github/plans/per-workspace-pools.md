# Plan: an account pool per workspace

Status: in progress (branch feat/pools).

## The idea

Today the proxy has one pool, and every login (the shared one and each isolated workspace) rotates across all of its accounts. Instead, a workspace can run on its own pool. For example:

- the shared login keeps one personal account (the default pool);
- the `work` workspace rotates between the two accounts the employer gave (`a@work`, `b@work`).

That way personal and work accounts never serve each other's conversations.

## Findings

- **CLIProxyAPI 8.0.23 has no per-client-key credential scoping** (verified in its source and config docs; upstream issue #5188 asked for exactly this, "bind downstream API keys to credential groups", and was closed with no change). `access.api-keys` admits a client to every credential. Its only scoping is a per-credential model `prefix` (with `routing.force-model-prefix`). Using that would mean every request names `pool/model`, and Claude Code asks for plain model ids (main model, subagents, the small fast model), so we'd have to rewrite all of them through `ANTHROPIC_DEFAULT_*_MODEL` overrides. That is too fragile.
- **So each pool is its own proxy instance.** It shares the pinned binary and the client key, and gets its own port, config, auth dir, log, and launchd agent. A pool is cheap: one small process, idle until used. Two instances run side by side with no shared state (tested: no shared home dir, lock, or extra port). This reuses CLIProxyAPI as it is; if `native-proxy.md` lands, pools become routing inside one process.
- **No portless.** Stable `*.localhost` names per pool (vercel-labs/portless, as zerostarter uses for its dev servers) were tried: SSE passes through at about 1 ms per request, but nobody types a pool URL (inscope writes it into settings.json), port changes already re-apply, and it would put a second, pre-1.0 daemon in front of every login. Revisit only for something people open in a browser.
- **Claude Code's settings.json `env` outranks the shell**, so a non-isolated workspace cannot be pooled by a hook export while `~/.claude/settings.json` routes to the default pool: a pool requires `isolate`.
- **An empty pool answers 400** ("unknown provider for model"), so empty pools must never exist: a pool whose first sign-in fails is removed, and a pool's last account cannot be removed while a login uses it.
- **An account lives in exactly one pool.** Two proxies holding the same account would both refresh its single-use refresh token, and one of them would break the login. So signing an account in to a second pool is refused, and moving it moves its auth file.

## Design

- **Config:** `proxy: { port }` stays, and is the `default` pool. New `pools: [{ name, port }]` holds the others. A workspace gets `pool: <name>`.
  - A workspace with a pool requires `isolate`: only an isolated workspace has a settings.json of its own. The shared `~/.claude` always uses the default pool.
  - A pool name is a lowercase slug (it becomes a dir name and a launchd label).
  - Each pool port is unique and valid.
- **Paths:**
  - The default pool keeps today's paths, so nothing migrates: `proxy/config.yaml`, `proxy/auth`, `proxy/proxy.log`, `dev.inscope.proxy`.
  - A named pool uses `proxy/pools/<name>/{config.yaml,auth,proxy.log}` and `dev.inscope.proxy.<name>`.
  - All pools share `proxy/bin` and `INSCOPE_PROXY_KEY`.
- **CLI:**
  - `inscope login [--pool <name>]` signs an account in to a pool. The first sign-in to a new pool creates it on the next free port (from the default pool's port + 1, so 8318 and up by default) and starts it. The default pool is unchanged.
  - `inscope logout <email>` finds the account in whichever pool holds it. It refuses a pool's last account while a login still uses that pool; removing the last account of an unused named pool removes the pool.
  - `inscope pool list` shows each pool, its port, its accounts, and the logins that use it.
  - No `pool move` in v1: the proxy rewrites an auth file in place on refresh, so moving it while the pool runs can race (the account resurrects in the old pool with the newer token). Moving an account is `logout` plus `login --pool`, a fresh sign-in.
  - `inscope add <path> --pool <name>` implies `--isolate`; `--pool default` clears it. `edit` keeps the field, and once named pools exist, `add` and `edit` ask for the pool interactively.
  - `inscope proxy status|start|stop|uninstall` act on every pool (one failing to start does not stop the others); `proxy setup [--pool <name>] [--port <n>]` reinstalls or moves one pool. When the client key has to be minted again (its Keychain item was lost), every installed pool gets the new key; doctor flags a pool whose config has another key.
- **Routing:** apply routes each login to its pool's port: the base and unpooled isolated logins to the default pool, and a pooled workspace to its pool.
- **Ports:** a new pool takes the first port from the default pool's port + 1 up that no pool uses and nothing is listening on; config validation rejects a port two pools share.
- **usage:** a POOL column, rows grouped by pool.
- **status:** shows the pool name next to the proxy host.
- **doctor:** per-pool checks for install, agent, port, accounts, and privacy; routing drift per login to its own pool.
- **Retiring:** `proxy uninstall` removes every pool. The last account of an unused named pool takes the pool with it. A pool dir the config no longer names (a hand-edited config) is flagged by doctor.

## Tests

- **Unit:** config validation (names, ports, pool requires isolate, duplicates), pool paths, port allocation, rendering a named pool's config and launchd agent (golden).
- **CLI in a sandbox:**
  - stand-in proxy and fake launchctl/security;
  - one Messages emulator per pool port for health checks;
  - login into a new pool creates it and routes only its workspace;
  - the same account in a second pool is refused;
  - a failed first sign-in into a new pool leaves no pool behind;
  - logout across pools, last-account refusal, uninstall removing every pool's agent.
- **Real CLIProxyAPI, two pools at once:** two pinned instances on two ports against a Messages emulator with distinct accounts. A request through each pool only ever reaches its own accounts, and failover stays inside a pool.
- **Real run on the Mac:**
  - sign the two Lightwork accounts out of the default pool and in to a new `lightwork` pool;
  - point the `lwai` workspace at it;
  - real Claude Code from `~/.claude` answers on the personal account, and from `lwai` on a Lightwork account;
  - `usage`, `status`, `doctor`, with screenshots.
