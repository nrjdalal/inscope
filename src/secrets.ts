import { spawnSync } from "node:child_process"

export type RunResult = { status: number; stdout: string; stderr: string }

export type RunOpts = { input?: string; env?: Record<string, string>; timeoutMs?: number }

export type Runner = (cmd: string, args: string[], opts?: RunOpts) => RunResult

export const defaultRunner: Runner = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts?.input,
    // Overlay onto the current env so a caller can pin one var (e.g.
    // CLAUDE_CONFIG_DIR for `claude auth status`) without dropping PATH/HOME.
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
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
const shSingleQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

export const keychainSetCommand = (service: string) =>
  `security add-generic-password -U -a "${user() || "$USER"}" -s ${shSingleQuote(service)} -w 'xoxp-...'`

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

export const claudeAuthStatus = (configDir: string, run: Runner = defaultRunner): ClaudeAuth => {
  const r = run("claude", ["auth", "status", "--json"], {
    env: { CLAUDE_CONFIG_DIR: configDir },
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
