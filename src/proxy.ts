import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { CREDENTIAL_ENV_VARS } from "@/accounts"
import type { Config, Gateway } from "@/config"
import { home, inscopeHome } from "@/env"
import { writeFileAtomic } from "@/io"
import { closeWindow, openSignInWindow } from "@/login"
import { defaultRunner, keychainSet, type Runner } from "@/secrets"

// A local CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) that holds several
// Claude accounts and keeps a conversation going when one of them hits its limit: a
// request that comes back 429 is retried on the next account in the same round, and
// session affinity then keeps the conversation on that account. inscope installs a
// pinned, checksum-verified release, writes a hardened config (loopback only, a random
// client key, no management API or web panel), runs it as a launchd agent, and points a
// workspace's Claude Code at it through the workspace gateway (ANTHROPIC_BASE_URL plus a
// Keychain apiKeyHelper). The accounts' tokens live only in the proxy's own auth dir.
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

export const proxyRoot = () => path.join(inscopeHome(), "proxy")
export const proxyBinPath = (version = PROXY_VERSION) =>
  path.join(proxyRoot(), "bin", version, "cli-proxy-api")
export const proxyConfigPath = () => path.join(proxyRoot(), "config.yaml")
export const proxyAuthDir = () => path.join(proxyRoot(), "auth")
export const proxyLogPath = () => path.join(proxyRoot(), "proxy.log")
export const launchAgentPath = () =>
  path.join(home(), "Library", "LaunchAgents", `${PROXY_LABEL}.plist`)

export const proxyUrl = (port: number) => `http://127.0.0.1:${port}`

// The gateway a workspace uses to reach the proxy.
export const proxyGateway = (port: number): Gateway => ({
  url: proxyUrl(port),
  keychain: PROXY_KEYCHAIN,
})

// The proxy's config. Hardened: bound to 127.0.0.1 only, a random client key (the one
// in the Keychain), the management API and its web panel off (the panel would
// otherwise download and run JavaScript from GitHub), request logs and usage stats
// off, and no plugins. Routing keeps one conversation on one account (session affinity,
// which also keeps its prompt cache) and fills one account before starting the next;
// when an account answers 429 the same request moves to the next account at once
// (no waiting on cooldowns), which is what lets a conversation carry on. Claude Code's
// own requests are passed through as Claude Code sent them (CLIProxyAPI cloaks only
// other clients). Pure, so it is golden-pinned.
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
export const renderLaunchAgent = (opts: { bin: string; config: string; log: string }) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by inscope (\`inscope proxy setup\`). -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PROXY_LABEL}</string>
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
  const dir = path.dirname(bin)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tarball = path.join(dir, asset.file)
  fs.writeFileSync(tarball, bytes, { mode: 0o600 })
  try {
    const r = (opts.run ?? defaultRunner)("tar", ["-xzf", tarball, "-C", dir, "cli-proxy-api"])
    if (r.status !== 0 || !fs.existsSync(bin))
      throw new Error(`unpacking ${asset.file} failed: ${r.stderr.trim() || "no binary"}`)
  } finally {
    fs.rmSync(tarball, { force: true })
  }
  fs.chmodSync(bin, 0o755)
  return bin
}

const readKey = (run: Runner) => {
  const r = run("security", ["find-generic-password", "-s", PROXY_KEYCHAIN, "-w"])
  return r.status === 0 ? r.stdout.trim() : ""
}

// The proxy's client key: the one already in the Keychain, else a new random one stored
// there. The config file needs it in plain text (the proxy reads it from there), so that
// file is written 0600 inside a 0700 dir.
export const ensureProxyKey = (run: Runner = defaultRunner): string => {
  const existing = readKey(run)
  if (existing) return existing
  const key = `inscope-${randomBytes(24).toString("hex")}`
  keychainSet(PROXY_KEYCHAIN, key, run)
  return key
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0)
const service = () => `gui/${uid()}/${PROXY_LABEL}`

// Write the config and launchd agent, then (re)start the agent so it picks them up.
export const writeProxyFiles = (port: number, key: string, bin: string) => {
  fs.mkdirSync(proxyRoot(), { recursive: true, mode: 0o700 })
  fs.chmodSync(proxyRoot(), 0o700)
  fs.mkdirSync(proxyAuthDir(), { recursive: true, mode: 0o700 })
  fs.chmodSync(proxyAuthDir(), 0o700)
  writeFileAtomic(proxyConfigPath(), renderProxyConfig({ port, key, authDir: proxyAuthDir() }))
  fs.chmodSync(proxyConfigPath(), 0o600)
  fs.mkdirSync(path.dirname(launchAgentPath()), { recursive: true })
  writeFileAtomic(
    launchAgentPath(),
    renderLaunchAgent({ bin, config: proxyConfigPath(), log: proxyLogPath() }),
  )
}

export const startProxy = (run: Runner = defaultRunner) => {
  run("launchctl", ["bootout", service()])
  const r = run("launchctl", ["bootstrap", `gui/${uid()}`, launchAgentPath()])
  if (r.status !== 0)
    throw new Error(`launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.status}`}`)
}

export const stopProxy = (run: Runner = defaultRunner) => {
  run("launchctl", ["bootout", service()])
}

export const proxyLoaded = (run: Runner = defaultRunner): boolean =>
  run("launchctl", ["print", service()]).status === 0

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

export const proxyAccounts = (): ProxyAccount[] => {
  let names: string[]
  try {
    names = fs.readdirSync(proxyAuthDir()).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: ProxyAccount[] = []
  for (const name of names.sort()) {
    const file = path.join(proxyAuthDir(), name)
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
// sign-in page, completed by you in a fresh Chrome window). The proxy writes the
// account's auth file and loads it without a restart. Afterwards the email that signed
// in is read back and checked against `email`, and a mismatch is removed again.
export const loginProxyAccount = async (opts: {
  email?: string
  openUrl?: (url: string) => void
  log?: (line: string) => void
  bin?: string
}): Promise<ProxyAccount> => {
  const bin = opts.bin ?? proxyBinPath()
  const log = opts.log ?? ((l: string) => console.log(l))
  const openUrl = opts.openUrl ?? ((url: string) => openSignInWindow(LOGIN_WINDOW, url))
  const started = Date.now()
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of CREDENTIAL_ENV_VARS) delete env[k]
  const child = spawn(bin, ["-config", proxyConfigPath(), "-claude-login", "-no-browser"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  })
  let opened = false
  let tail = ""
  const onData = (d: Buffer) => {
    tail = (tail + d.toString()).slice(-4000)
    const url = tail.match(/https:\/\/\S+/)?.[0]
    if (url && !opened && /\n/.test(tail.slice(tail.indexOf(url)))) {
      opened = true
      log("Sign in to Claude in the new Chrome window; this continues when you are done.")
      openUrl(url)
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)))
  closeWindow(LOGIN_WINDOW)
  if (!opened) throw new Error(`the proxy's login did not print a sign-in URL:\n${tail.trim()}`)
  const fresh = proxyAccounts().filter((a) => fs.statSync(a.file).mtimeMs >= started - 1000)
  if (code !== 0 || !fresh.length)
    throw new Error(
      `the sign-in did not complete (the proxy's login exited ${code}); nothing was saved`,
    )
  const account = fresh[fresh.length - 1]
  if (opts.email && account.email.toLowerCase() !== opts.email.toLowerCase()) {
    fs.rmSync(account.file, { force: true })
    throw new Error(
      `signed in as ${account.email}, not ${opts.email}; removed it from the proxy. Sign in with ${opts.email}.`,
    )
  }
  return account
}

// Remove an account from the proxy (it unloads the auth file on its own).
export const logoutProxyAccount = (email: string): boolean => {
  const hits = proxyAccounts().filter((a) => a.email.toLowerCase() === email.toLowerCase())
  for (const a of hits) fs.rmSync(a.file, { force: true })
  return hits.length > 0
}

// The workspaces whose gateway points at the proxy.
export const proxyUsers = (cfg: Config): string[] =>
  cfg.proxy
    ? cfg.workspaces.filter((w) => w.gateway?.url === proxyUrl(cfg.proxy!.port)).map((w) => w.name)
    : []
