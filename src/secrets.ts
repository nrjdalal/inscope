import { spawnSync } from "node:child_process"

export type RunResult = { status: number; stdout: string; stderr: string }

export type RunOpts = {
  input?: string
  env?: Record<string, string>
  // Variables to remove from the child's environment (an overlay cannot unset one).
  unset?: string[]
  cwd?: string
  timeoutMs?: number
}

export type Runner = (cmd: string, args: string[], opts?: RunOpts) => RunResult

export const defaultRunner: Runner = (cmd, args, opts) => {
  let env: NodeJS.ProcessEnv | undefined
  if (opts?.env || opts?.unset?.length) {
    // Overlay onto the current env so a caller can pin one var (e.g.
    // CLAUDE_CONFIG_DIR for `claude auth status`) without dropping PATH/HOME.
    env = { ...process.env, ...opts.env }
    for (const k of opts.unset ?? []) delete env[k]
  }
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts?.input,
    env,
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs,
  })
  return {
    status: res.status ?? (res.error ? 127 : 1),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  }
}

export const isMacOS = () => process.platform === "darwin"

const user = () => process.env.USER || ""

export const ghToken = (account: string, run: Runner = defaultRunner) => {
  const r = run("gh", ["auth", "token", "-u", account])
  const tok = r.stdout.trim()
  return r.status === 0 && tok ? tok : null
}

export const ghStatus = (run: Runner = defaultRunner) => {
  const r = run("gh", ["auth", "status"])
  return (r.stdout + r.stderr).trim()
}

// Unique gh accounts parsed from `gh auth status`, in the order they appear.
export const ghAccounts = (run: Runner = defaultRunner): string[] => {
  const names: string[] = []
  for (const m of ghStatus(run).matchAll(/account (\S+) \(/g)) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

export const gitGlobal = (key: string, run: Runner = defaultRunner): string | null => {
  const r = run("git", ["config", "--global", key])
  const v = r.stdout.trim()
  return r.status === 0 && v ? v : null
}

export const keychainHas = (service: string, run: Runner = defaultRunner) => {
  const r = run("security", ["find-generic-password", "-a", user(), "-s", service, "-w"])
  return r.status === 0 && r.stdout.trim().length > 0
}

export const keychainSet = (service: string, token: string, run: Runner = defaultRunner) => {
  const r = run("security", [
    "add-generic-password",
    "-U",
    "-a",
    user(),
    "-s",
    service,
    "-w",
    token,
  ])
  if (r.status !== 0) {
    throw new Error(`security add-generic-password failed: ${r.stderr.trim() || "unknown error"}`)
  }
}

// Single-quote the service: it comes from config (the Slack `keychain` value) and
// this string is meant to be copy-pasted into a shell, so an unquoted value with
// shell metacharacters would inject into the pasted command.
export const shSingleQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

// A path for a copy-paste command: single-quoted so spaces and metacharacters stay
// one argument (an unquoted `~/Client Work/acme` makes `rm -rf` hit `~/Client`),
// with a leading `~/` left outside the quotes so the shell still expands it.
export const shQuotePath = (p: string) => {
  if (p === "~") return "~"
  if (p.startsWith("~/")) return `~/${shSingleQuote(p.slice(2))}`
  return shSingleQuote(p)
}

export const keychainSetCommand = (service: string, placeholder = "xoxp-...") =>
  `security add-generic-password -U -a "${user() || "$USER"}" -s ${shSingleQuote(service)} -w '${placeholder}'`

export const gitEmailForFile = (file: string, run: Runner = defaultRunner) => {
  const r = run("git", ["config", "--file", file, "user.email"])
  return r.status === 0 ? r.stdout.trim() : null
}

// The Claude login a config dir is signed into, read from `claude auth status
// --json` with CLAUDE_CONFIG_DIR pinned to that dir (an isolated workspace's own
// `.inscope`, or the shared base). Any failure, claude not installed, an older
// CLI without `--json`, an unparseable body, or a signed-out dir, degrades to
// { signedIn: false } so `inscope status` reports "not signed in" instead of
// throwing. The short timeout keeps status snappy if claude ever hangs.
export type ClaudeAuth = {
  signedIn: boolean
  email?: string
  subscriptionType?: string
  orgName?: string
}

// `configDir` undefined means Claude's default login with CLAUDE_CONFIG_DIR unset (its
// bare Keychain slot), which is a different login from CLAUDE_CONFIG_DIR=~/.claude.
export const claudeAuthStatus = (
  configDir: string | undefined,
  run: Runner = defaultRunner,
  opts: { unset?: string[] } = {},
): ClaudeAuth => {
  const r = run("claude", ["auth", "status", "--json"], {
    ...(configDir === undefined
      ? { unset: ["CLAUDE_CONFIG_DIR", ...(opts.unset ?? [])] }
      : { env: { CLAUDE_CONFIG_DIR: configDir }, unset: opts.unset }),
    timeoutMs: 5000,
  })
  if (r.status !== 0 || !r.stdout.trim()) return { signedIn: false }
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
    return {
      signedIn: j.loggedIn === true,
      email: str(j.email),
      subscriptionType: str(j.subscriptionType),
      orgName: str(j.orgName),
    }
  } catch {
    return { signedIn: false }
  }
}
