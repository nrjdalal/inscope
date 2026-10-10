import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

import type { Config, Pool, Workspace } from "@/config"
import { home, inscopeHome } from "@/env"
import { readFileOrNull, writeFileAtomic } from "@/io"
import {
  type BrowserMode,
  childEnv,
  closeWindow,
  defaultBrowserMode,
  openSignInWindow,
  sleepSync,
} from "@/login"
import { defaultRunner, keychainSet, type Runner } from "@/secrets"

// A local CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) that holds several
// Claude accounts and keeps a conversation going when one of them hits its limit: a
// request that comes back 429 is retried on the next account in the same round, and
// session affinity then keeps the conversation on that account. inscope installs a
// pinned, checksum-verified release, writes a hardened config (loopback only, a random
// client key, no management API or web panel), runs it as a launchd agent, and points
// every Claude Code login at it (ANTHROPIC_BASE_URL plus a Keychain apiKeyHelper, see
// generators/settings.ts). The accounts' tokens live only in the proxy's own auth dir.
//
// Anthropic's terms forbid third parties that store or intermediate Claude.ai
// credentials, which is what a proxy like this does; running it is the user's choice.

// The release inscope is tested against. Pinned (not "latest"): the proxy rewrites
// Claude Code requests, and an untested release can change how.
export const PROXY_VERSION = "8.0.23"

export type ProxyAsset = { file: string; sha256: string }

const PROXY_ASSETS: Record<string, ProxyAsset> = {
  arm64: {
    file: `CLIProxyAPI_${PROXY_VERSION}_darwin_aarch64.tar.gz`,
    sha256: "3c056b42ec4c80d06a74d3c5abf47ae0adb06285e32f5cf31a29bdd07017feb3",
  },
  x64: {
    file: `CLIProxyAPI_${PROXY_VERSION}_darwin_amd64.tar.gz`,
    sha256: "bfa737b927cd7680ca78a4126c2e09edd1ed510c18605123cf15f2dbae47d896",
  },
}

export const proxyAsset = (arch: string = process.arch): ProxyAsset => {
  if (process.platform !== "darwin" && !process.env.INSCOPE_PROXY_ANY_OS)
    throw new Error("the proxy is supported on macOS only")
  const asset = PROXY_ASSETS[arch]
  if (!asset) throw new Error(`no CLIProxyAPI build for ${arch}`)
  return asset
}

const RELEASES = "https://github.com/router-for-me/CLIProxyAPI/releases/download"

export const PROXY_LABEL = "dev.inscope.proxy"
export const PROXY_KEYCHAIN = "INSCOPE_PROXY_KEY"
export const DEFAULT_PROXY_PORT = 8317

// Accounts are grouped in pools, each its own proxy instance (CLIProxyAPI cannot tie a
// client key to some of its accounts): one port, config, auth dir, log, and launchd
// agent per pool, sharing the binary and the client key. The default pool keeps the
// paths a single proxy always had; a named pool lives under pools/<name>.
export const DEFAULT_POOL = "default"

export const proxyRoot = () => path.join(inscopeHome(), "proxy")
export const proxyBinPath = (version = PROXY_VERSION) =>
  path.join(proxyRoot(), "bin", version, "cli-proxy-api")
export const poolDir = (pool = DEFAULT_POOL) =>
  pool === DEFAULT_POOL ? proxyRoot() : path.join(proxyRoot(), "pools", pool)
export const proxyConfigPath = (pool = DEFAULT_POOL) => path.join(poolDir(pool), "config.yaml")
export const proxyAuthDir = (pool = DEFAULT_POOL) => path.join(poolDir(pool), "auth")
export const proxyLogPath = (pool = DEFAULT_POOL) => path.join(poolDir(pool), "proxy.log")
export const proxyLabel = (pool = DEFAULT_POOL) =>
  pool === DEFAULT_POOL ? PROXY_LABEL : `${PROXY_LABEL}.${pool}`
export const launchAgentPath = (pool = DEFAULT_POOL) =>
  path.join(home(), "Library", "LaunchAgents", `${proxyLabel(pool)}.plist`)

export const proxyUrl = (port: number) => `http://127.0.0.1:${port}`

// Where a login's Claude Code sends its requests: the proxy's URL, and the Keychain item
// holding the client key it expects (sent as both `Authorization: Bearer` and
// `x-api-key`).
export type Route = { url: string; keychain: string }

export const routeTo = (port: number): Route => ({
  url: proxyUrl(port),
  keychain: PROXY_KEYCHAIN,
})

// [the dated id the proxy lists, the undated alias Anthropic's API also accepts]
const MODEL_ALIASES: [string, string][] = [
  ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
  ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
  ["claude-opus-4-5-20251101", "claude-opus-4-5"],
  ["claude-opus-4-1-20250805", "claude-opus-4-1"],
  ["claude-sonnet-4-20250514", "claude-sonnet-4-0"],
  ["claude-opus-4-20250514", "claude-opus-4-0"],
]

// The proxy's config. Hardened: bound to 127.0.0.1 only, a random client key (the one
// in the Keychain), the management API and its web panel off (the panel would
// otherwise download and run JavaScript from GitHub), request logs and usage stats
// off, and no plugins. Routing keeps one conversation on one account (session affinity,
// which also keeps its prompt cache) and fills one account before starting the next;
// when an account answers 429 the same request moves to the next account at once
// (no waiting on cooldowns), which is what lets a conversation carry on. Claude Code's
// own requests are passed through as Claude Code sent them (CLIProxyAPI cloaks only
// other clients). The proxy lists dated ids for older models, so the undated aliases
// Anthropic's API also accepts (`claude-haiku-4-5`) are mapped onto them. CLIProxyAPI
// still keeps its last 10 failed requests (credentials masked) under the auth dir's
// logs/, which is owner-only. Pure, so it is golden-pinned.
export const renderProxyConfig = (opts: { port: number; key: string; authDir: string }) =>
  `# Managed by inscope (\`inscope proxy setup\`). Do not edit by hand: re-run setup instead.
config-version: 8
server:
  host: "127.0.0.1"
  port: ${opts.port}
  trusted-proxies: []
  discovery:
    enabled: false
management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
access:
  api-keys:
    - ${JSON.stringify(opts.key)}
routing:
  strategy: "fill-first"
  session-affinity: true
  session-affinity-ttl: "1h"
  session-affinity-subagents: true
  retry:
    request-retry: 1
    max-retry-credentials: 0
    max-retry-interval: 0
oauth:
  auth-dir: ${JSON.stringify(opts.authDir)}
  model-alias:
    claude:
${MODEL_ALIASES.map(([name, alias]) => `      - name: "${name}"\n        alias: "${alias}"\n        fork: true`).join("\n")}
observability:
  logs:
    debug: false
    logging-to-file: false
    request-log: false
  usage:
    usage-statistics-enabled: false
plugins:
  enabled: false
`

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// The launchd agent that runs the proxy at login and restarts it if it exits. Pure,
// golden-pinned.
export const renderLaunchAgent = (opts: {
  bin: string
  config: string
  log: string
  label?: string
}) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by inscope (\`inscope proxy setup\`). -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${opts.label ?? PROXY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.bin)}</string>
    <string>-config</string>
    <string>${xml(opts.config)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.log)}</string>
</dict>
</plist>
`

export type FetchBytes = (url: string) => Promise<{ status: number; bytes: Uint8Array }>

const defaultFetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) })
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) }
}

// Download the pinned release, refuse it unless its sha256 matches the one built into
// inscope, and unpack the binary. A no-op when that version is already installed.
export const installProxy = async (
  opts: { fetchBytes?: FetchBytes; run?: Runner; asset?: ProxyAsset; version?: string } = {},
): Promise<string> => {
  const version = opts.version ?? PROXY_VERSION
  const bin = proxyBinPath(version)
  if (fs.existsSync(bin)) return bin
  const asset = opts.asset ?? proxyAsset()
  const { status, bytes } = await (opts.fetchBytes ?? defaultFetchBytes)(
    `${RELEASES}/v${version}/${asset.file}`,
  )
  if (status !== 200) throw new Error(`downloading ${asset.file} failed (HTTP ${status})`)
  const sha = createHash("sha256").update(bytes).digest("hex")
  if (sha !== asset.sha256)
    throw new Error(
      `${asset.file} does not match its pinned checksum (got ${sha}); refusing to install it`,
    )
  // Unpack into a staging dir and rename it into place, so an interrupted install
  // never leaves a binary behind that the existsSync check above would then trust.
  const dir = path.dirname(bin)
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  const stage = fs.mkdtempSync(`${dir}.partial-`)
  try {
    const tarball = path.join(stage, asset.file)
    fs.writeFileSync(tarball, bytes, { mode: 0o600 })
    const r = (opts.run ?? defaultRunner)("tar", ["-xzf", tarball, "-C", stage, "cli-proxy-api"])
    const staged = path.join(stage, path.basename(bin))
    if (r.status !== 0 || !fs.existsSync(staged))
      throw new Error(`unpacking ${asset.file} failed: ${r.stderr.trim() || "no binary"}`)
    fs.rmSync(tarball)
    fs.chmodSync(staged, 0o755)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(stage, dir)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  return bin
}

// The proxy's client key from the Keychain, or "" when there is none.
export const readProxyKey = (run: Runner = defaultRunner) => {
  const r = run("security", ["find-generic-password", "-s", PROXY_KEYCHAIN, "-w"])
  return r.status === 0 ? r.stdout.trim() : ""
}

// The proxy's client key: the one already in the Keychain, else a new random one stored
// there. The config file needs it in plain text (the proxy reads it from there), so that
// file is written 0600 inside a 0700 dir.
export const ensureProxyKey = (run: Runner = defaultRunner): string => {
  const existing = readProxyKey(run)
  if (existing) return existing
  const key = `inscope-${randomBytes(24).toString("hex")}`
  keychainSet(PROXY_KEYCHAIN, key, run)
  return key
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0)
const service = (pool = DEFAULT_POOL) => `gui/${uid()}/${proxyLabel(pool)}`

// Write the config and launchd agent (startProxy then loads them).
export const writeProxyFiles = (
  port: number,
  key: string,
  bin: string,
  pool = DEFAULT_POOL,
  opts: { agent?: boolean } = {},
) => {
  for (const dir of [proxyRoot(), poolDir(pool), proxyAuthDir(pool)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
  }
  const config = proxyConfigPath(pool)
  writeFileAtomic(config, renderProxyConfig({ port, key, authDir: proxyAuthDir(pool) }))
  fs.chmodSync(config, 0o600)
  if (opts.agent === false) return
  fs.mkdirSync(path.dirname(launchAgentPath(pool)), { recursive: true })
  writeFileAtomic(
    launchAgentPath(pool),
    renderLaunchAgent({ bin, config, log: proxyLogPath(pool), label: proxyLabel(pool) }),
  )
}

// launchd unloads a booted-out agent asynchronously, and bootstrapping it again before
// that finishes fails ("Bootstrap failed: 5: Input/output error"), so wait it out.
export const stopProxy = (
  run: Runner = defaultRunner,
  opts: { waitMs?: number; pool?: string } = {},
) => {
  run("launchctl", ["bootout", service(opts.pool)])
  const until = Date.now() + (opts.waitMs ?? 10_000)
  while (proxyLoaded(run, opts.pool) && Date.now() < until) sleepSync(100)
}

export const startProxy = (
  run: Runner = defaultRunner,
  opts: { waitMs?: number; pool?: string } = {},
) => {
  stopProxy(run, opts)
  const r = run("launchctl", ["bootstrap", `gui/${uid()}`, launchAgentPath(opts.pool)])
  if (r.status !== 0)
    throw new Error(`launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.status}`}`)
}

export const proxyLoaded = (run: Runner = defaultRunner, pool = DEFAULT_POOL): boolean =>
  run("launchctl", ["print", service(pool)]).status === 0

export type FetchStatus = (url: string, headers: Record<string, string>) => Promise<number>

const defaultFetchStatus: FetchStatus = async (url, headers) =>
  (await fetch(url, { headers, signal: AbortSignal.timeout(3000) })).status

// Whether the proxy answers an authenticated request, retried for up to `waitMs` (it
// takes a moment to start).
export const proxyHealthy = async (
  port: number,
  key: string,
  opts: { waitMs?: number; fetchStatus?: FetchStatus } = {},
): Promise<boolean> => {
  const until = Date.now() + (opts.waitMs ?? 0)
  for (;;) {
    try {
      const status = await (opts.fetchStatus ?? defaultFetchStatus)(`${proxyUrl(port)}/v1/models`, {
        "x-api-key": key,
      })
      if (status === 200) return true
    } catch {}
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

// A Claude account signed in to the proxy, read from its auth file.
export type ProxyAccount = {
  file: string
  email: string
  accessToken?: string
  expiresAt?: number
  disabled: boolean
}

export const proxyAccounts = (pool = DEFAULT_POOL): ProxyAccount[] => {
  let names: string[]
  try {
    names = fs.readdirSync(proxyAuthDir(pool)).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: ProxyAccount[] = []
  for (const name of names.sort()) {
    const file = path.join(proxyAuthDir(pool), name)
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"))
      if (doc?.type !== "claude" || typeof doc.email !== "string") continue
      const at = typeof doc.expired === "string" ? Date.parse(doc.expired) : NaN
      out.push({
        file,
        email: doc.email,
        accessToken: typeof doc.access_token === "string" ? doc.access_token : undefined,
        expiresAt: Number.isNaN(at) ? undefined : at,
        disabled: doc.disabled === true,
      })
    } catch {}
  }
  return out
}

const LOGIN_WINDOW = "proxy"

// Sign a Claude account in to the proxy through the proxy's own login (Anthropic's
// sign-in page, completed by you). `mode` picks where that page opens, as for
// `inscope login`: a new Chrome window on a fresh profile, your usual browser, or the
// printed URL. Afterwards the email that signed in is read back and checked against
// `email`, and a mismatch is removed again. `openUrl` replaces the opener (tests).
export const loginProxyAccount = async (opts: {
  email?: string
  mode?: BrowserMode
  openUrl?: (url: string) => void
  log?: (line: string) => void
  bin?: string
  pool?: string
}): Promise<ProxyAccount> => {
  const bin = opts.bin ?? proxyBinPath()
  const log = opts.log ?? ((l: string) => console.log(l))
  const mode = opts.mode ?? defaultBrowserMode()
  const openUrl =
    opts.openUrl ??
    ((url: string) => {
      if (mode === "chrome") openSignInWindow(LOGIN_WINDOW, url)
      else if (mode === "system") spawnSync("open", [url], { stdio: "ignore" })
      else log(`Open this URL in the browser you want to sign in with:\n${url}`)
    })
  const pool = opts.pool ?? DEFAULT_POOL
  const child = spawn(bin, ["-config", proxyConfigPath(pool), "-claude-login", "-no-browser"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(),
  })
  let opened = false
  let failed: unknown
  let tail = ""
  const onData = (d: Buffer) => {
    tail = (tail + d.toString()).slice(-4000)
    const url = tail.match(/https:\/\/\S+/)?.[0]
    if (url && !opened && /\n/.test(tail.slice(tail.indexOf(url)))) {
      opened = true
      if (mode !== "none")
        log(
          mode === "chrome"
            ? "A new Chrome window (a fresh profile, deleted afterwards) opened on Claude's sign-in page. Enter the account's email, then the code Claude emails you, then authorize; this continues once you do."
            : "Sign in to Claude in your browser; this continues once you do.",
        )
      // An opener that throws (no Chrome, say) must not leave the login running.
      try {
        openUrl(url)
      } catch (e) {
        failed = e
        child.kill()
      }
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)))
  closeWindow(LOGIN_WINDOW)
  if (failed) throw failed
  if (!opened) throw new Error(`the proxy's login did not print a sign-in URL:\n${tail.trim()}`)
  // The file the proxy says it saved: the running proxy also rewrites other accounts'
  // files when it refreshes their tokens, so a recently changed file proves nothing.
  const saved = tail.match(/Authentication saved to (.+)/)?.[1]?.trim()
  const account = saved
    ? proxyAccounts(pool).find((a) => a.file === path.resolve(proxyAuthDir(pool), saved))
    : undefined
  if (code !== 0 || !account)
    throw new Error(
      `the sign-in did not complete (the proxy's login exited ${code}); nothing was saved`,
    )
  // The proxy writes auth files 0644; they hold the account's tokens, so keep them
  // owner-only (the auth dir is 0700 as well).
  fs.chmodSync(account.file, 0o600)
  if (opts.email && account.email.toLowerCase() !== opts.email.toLowerCase()) {
    fs.rmSync(account.file, { force: true })
    throw new Error(
      `signed in as ${account.email}, not ${opts.email}; removed it from the proxy. Sign in with ${opts.email}.`,
    )
  }
  // Signing an account in again (to renew it, say) replaces its earlier file.
  for (const a of proxyAccounts(pool))
    if (a.file !== account.file && a.email.toLowerCase() === account.email.toLowerCase())
      fs.rmSync(a.file, { force: true })
  return account
}

// Remove an account from the proxy (it unloads the auth file on its own).
export const logoutProxyAccount = (email: string, pool = DEFAULT_POOL): boolean => {
  const hits = proxyAccounts(pool).filter((a) => a.email.toLowerCase() === email.toLowerCase())
  for (const a of hits) fs.rmSync(a.file, { force: true })
  return hits.length > 0
}

// Install (or keep) the pinned proxy, make sure its client key exists, write its
// config and launchd agent, (re)start it, and wait until it answers. Throws when it
// does not come up. Does not touch the inscope config: the caller records the port
// once there is an account to route to.
export const setupProxy = async (
  port: number,
  opts: { run?: Runner; log?: (line: string) => void; pool?: string } = {},
) => {
  const run = opts.run ?? defaultRunner
  const pool = opts.pool ?? DEFAULT_POOL
  opts.log?.(`Installing CLIProxyAPI ${PROXY_VERSION} (checksum-verified)...`)
  const bin = await installProxy({ run })
  const had = readProxyKey(run)
  const key = ensureProxyKey(run)
  // A new client key (the Keychain item was gone) must reach every pool, or the pools
  // not being set up here keep the old key and reject every login's requests.
  if (had !== key) rekeyPools(key, bin, run, pool, opts.log)
  writeProxyFiles(port, key, bin, pool)
  startProxy(run, { pool })
  if (!(await proxyHealthy(port, key, { waitMs: 15_000 })))
    throw new Error(
      `the proxy${pool === DEFAULT_POOL ? "" : ` for pool ${pool}`} did not come up on ${proxyUrl(port)}; see ${proxyLogPath(pool)}. Is the port in use? Pick another with --port.`,
    )
}

// The pools installed on disk, with the port each config names: the default pool's
// config, and every pools/<name>/config.yaml. Reads the `  port: N` line
// renderProxyConfig writes (inscope owns these files).
const installedPools = (): Pool[] => {
  const out: Pool[] = []
  const read = (name: string) => {
    const m = readFileOrNull(proxyConfigPath(name))?.match(/^ {2}port: (\d+)$/m)
    if (m) out.push({ name, port: Number(m[1]) })
  }
  read(DEFAULT_POOL)
  try {
    for (const d of fs.readdirSync(path.join(proxyRoot(), "pools"), { withFileTypes: true }))
      if (d.isDirectory()) read(d.name)
  } catch {}
  return out
}

// Rewrite every other installed pool's config with `key`, restarting the ones running.
// A pool that is not running (one an uninstall kept the files of) gets only its config,
// never a launchd agent that would start it at the next login. One pool failing to
// restart does not stop the others; doctor then flags its key.
const rekeyPools = (
  key: string,
  bin: string,
  run: Runner,
  except: string,
  log?: (line: string) => void,
) => {
  for (const p of installedPools()) {
    if (p.name === except) continue
    const running = proxyLoaded(run, p.name)
    writeProxyFiles(p.port, key, bin, p.name, { agent: running })
    if (!running) continue
    try {
      startProxy(run, { pool: p.name })
    } catch (err) {
      log?.(
        `pool ${p.name} did not restart on the new key: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}

// Whether a pool's config admits `key` (the client key the logins send), by the
// `    - "<key>"` api-keys line renderProxyConfig writes.
export const poolHasKey = (pool: string, key: string): boolean =>
  Boolean(readFileOrNull(proxyConfigPath(pool))?.includes(`- ${JSON.stringify(key)}`))

// Stop the proxy and remove its launchd agent, so launchd neither restarts it nor starts
// it at the next login. The binary, config, and accounts stay.
export const retireProxyAgent = (run: Runner = defaultRunner, pool = DEFAULT_POOL) => {
  stopProxy(run, { pool })
  fs.rmSync(launchAgentPath(pool), { force: true })
}

// Stop every pool's proxy and remove its launchd agent, and the binary. `purge` also
// removes the accounts, configs, and logs, and the client key from the Keychain.
export const uninstallProxy = (opts: { pools?: string[]; purge?: boolean; run?: Runner } = {}) => {
  const run = opts.run ?? defaultRunner
  for (const pool of opts.pools ?? [DEFAULT_POOL]) retireProxyAgent(run, pool)
  fs.rmSync(path.join(proxyRoot(), "bin"), { recursive: true, force: true })
  if (opts.purge) {
    fs.rmSync(proxyRoot(), { recursive: true, force: true })
    run("security", ["delete-generic-password", "-s", PROXY_KEYCHAIN])
  }
}

// Every pool the config knows, as name and port: the default pool first.
export const configPools = (cfg: Config | null | undefined): Pool[] =>
  cfg?.proxy ? [{ name: DEFAULT_POOL, port: cfg.proxy.port }, ...(cfg.pools ?? [])] : []

export const poolPort = (cfg: Config | null | undefined, pool: string): number | undefined =>
  configPools(cfg).find((p) => p.name === pool)?.port

// The pool a login runs on: a pooled isolated workspace's own, else the default pool
// (the shared ~/.claude and every other login).
export const poolOf = (ws: Workspace | undefined): string =>
  ws?.isolate && ws.pool ? ws.pool : DEFAULT_POOL

// Where a login sends its requests: its pool's proxy, once the proxy is set up.
export const routeFor = (cfg: Config | null | undefined, ws?: Workspace): Route | undefined => {
  const port = poolPort(cfg, poolOf(ws))
  return port === undefined ? undefined : routeTo(port)
}

// Every account in every pool, with the pool that holds it.
export const poolAccounts = (cfg: Config | null | undefined) =>
  configPools(cfg).flatMap((p) =>
    proxyAccounts(p.name).map((account) => ({ pool: p.name, account })),
  )

// Who a pool serves: "the shared login" for the default pool, then every isolated
// workspace routed to it, by name.
export const poolUsers = (cfg: Config, pool: string): string[] => [
  ...(pool === DEFAULT_POOL ? ["the shared login"] : []),
  ...cfg.workspaces.filter((w) => w.isolate && poolOf(w) === pool).map((w) => w.name),
]

// `--pool <name>` for a named pool, nothing for the default one (for printed commands).
export const poolFlag = (pool: string) => (pool === DEFAULT_POOL ? "" : ` --pool ${pool}`)

// How output names a pool: "the proxy" for the default one, "pool <name>" otherwise.
export const poolLabel = (pool: string) => (pool === DEFAULT_POOL ? "the proxy" : `pool ${pool}`)

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once("error", () => resolve(false))
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)))
  })

// The port for a new pool: the first from the default pool's port + 1 up that no pool
// uses and nothing listens on.
export const nextPoolPort = async (cfg: Config): Promise<number> => {
  const taken = new Set(configPools(cfg).map((p) => p.port))
  for (let port = (cfg.proxy?.port ?? DEFAULT_PROXY_PORT) + 1; port <= 65535; port++)
    if (!taken.has(port) && (await portFree(port))) return port
  throw new Error("no free port for a new pool")
}
