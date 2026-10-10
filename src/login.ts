import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { accountDir, accountsRoot } from "@/accounts"
import { writeFileAtomic } from "@/io"
import { claudeAuthStatus, defaultRunner, type Runner } from "@/secrets"

// How `inscope login` shows Claude's sign-in page. Claude Code opens the URL through
// $BROWSER when it is set, so inscope points $BROWSER at a tiny shim:
// - agent:  a fresh, isolated agent-browser session per login, so two accounts never
//           share browser cookies (the usual cause of logging the same account in twice)
// - system: your default browser (whatever account it is signed in to)
// - none:   open nothing; Claude prints the URL to open yourself
export const BROWSER_MODES = ["agent", "system", "none"] as const

export type BrowserMode = (typeof BROWSER_MODES)[number]

export const agentBrowserAvailable = (run: Runner = defaultRunner): boolean =>
  run("agent-browser", ["--version"]).status === 0

// Variables that would make Claude Code skip its subscription login (an API key or a
// gateway) are dropped for the child, so the sign-in is always the claude.ai OAuth flow.
const GATEWAY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of GATEWAY_VARS) delete env[k]
  return env
}

const shimDir = () => path.join(accountsRoot(), ".browser")

// Write the $BROWSER shim for a mode and return its path. The URL Claude passes is
// forwarded as a single quoted argument, never interpolated into a command string.
export const writeBrowserShim = (mode: Exclude<BrowserMode, "system">): string => {
  fs.mkdirSync(shimDir(), { recursive: true, mode: 0o700 })
  const file = path.join(shimDir(), `${mode}.sh`)
  const body =
    mode === "agent"
      ? `#!/bin/sh
# inscope login: open Claude's sign-in URL in an isolated, visible agent-browser session.
exec agent-browser --session "$INSCOPE_LOGIN_SESSION" --headed open "$1"
`
      : `#!/bin/sh
# inscope login: open nothing; claude prints the sign-in URL in the terminal.
exit 0
`
  writeFileAtomic(file, body)
  fs.chmodSync(file, 0o700)
  return file
}

export type LoginResult = { email: string; subscriptionType?: string }

// The agent-browser session a login opens its sign-in page in, one per account name.
export const loginSession = (name: string) => `inscope-login-${name}`

export type LoginOptions = {
  name: string
  email?: string
  mode: BrowserMode
  // Accounts already recorded, so the same Claude account is not signed in twice
  // under two names (their usage would be double-counted and the "pool" is fake).
  otherAccounts: { name: string; email?: string }[]
  run?: Runner
  log?: (line: string) => void
}

// Sign `name` in through Claude Code's own `claude auth login`, with CLAUDE_CONFIG_DIR
// pinned to the account's dir, so Claude stores the token in that dir's own Keychain
// slot; inscope never sees or stores a credential. Afterwards the effective login is
// read back with `claude auth status` (the check the old account pool never made) and
// rejected, and signed back out, if it is not the account that was asked for.
export const loginAccount = (opts: LoginOptions): LoginResult => {
  const run = opts.run ?? defaultRunner
  const log = opts.log ?? ((l: string) => console.log(l))
  const dir = accountDir(opts.name)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)

  const extra: Record<string, string> = { CLAUDE_CONFIG_DIR: dir }
  const session = loginSession(opts.name)
  if (opts.mode !== "system") extra.BROWSER = writeBrowserShim(opts.mode)
  if (opts.mode === "agent") {
    extra.INSCOPE_LOGIN_SESSION = session
    // A predictable session name (printed below) lets an agent drive the sign-in page in
    // this exact window, e.g. Claude through the inscope skill asking you for the
    // emailed code. Close a leftover window from an earlier, interrupted login first, so
    // this sign-in starts from a clean browser with no other account's cookies.
    spawnSync("agent-browser", ["--session", session, "close"], { stdio: "ignore" })
    log(`agent-browser session: ${session}`)
  }

  const args = ["auth", "login", ...(opts.email ? ["--email", opts.email] : [])]
  const res = spawnSync("claude", args, { stdio: "inherit", env: childEnv(extra) })
  if (opts.mode === "agent")
    spawnSync("agent-browser", ["--session", session, "close"], { stdio: "ignore" })
  if (res.error) throw new Error(`could not run claude: ${res.error.message}`)
  if (res.status !== 0)
    throw new Error(`claude auth login exited with ${res.status}; nothing was saved`)

  const auth = claudeAuthStatus(dir, run)
  if (!auth.signedIn || !auth.email)
    throw new Error(
      `the sign-in did not complete (claude reports no login in ${dir}); nothing was saved`,
    )

  const signOut = () => run("claude", ["auth", "logout"], { env: { CLAUDE_CONFIG_DIR: dir } })
  if (opts.email && auth.email.toLowerCase() !== opts.email.toLowerCase()) {
    signOut()
    throw new Error(
      `signed in as ${auth.email}, not ${opts.email}; signed it back out. Sign in with ${opts.email} (a fresh browser session helps).`,
    )
  }
  const dupe = opts.otherAccounts.find(
    (a) => a.name !== opts.name && a.email?.toLowerCase() === auth.email!.toLowerCase(),
  )
  if (dupe) {
    signOut()
    throw new Error(
      `${auth.email} is already account "${dupe.name}"; signed this one back out. Sign in with a different Claude account.`,
    )
  }
  log(`signed in as ${auth.email}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ""}`)
  return { email: auth.email, subscriptionType: auth.subscriptionType }
}

// Sign an account out through Claude Code (which deletes its Keychain token). The
// dir itself, with that login's history, is left for the user to delete.
export const logoutAccount = (name: string, run: Runner = defaultRunner): boolean =>
  run("claude", ["auth", "logout"], { env: { CLAUDE_CONFIG_DIR: accountDir(name) } }).status === 0
