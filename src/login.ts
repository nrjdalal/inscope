import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { accountDir, accountsRoot, CREDENTIAL_ENV_VARS } from "@/accounts"
import { writeFileAtomic } from "@/io"
import { claudeAuthStatus, defaultRunner, type Runner } from "@/secrets"

// How `inscope login` shows Claude's sign-in page. Claude Code opens the URL through
// $BROWSER when it is set, so inscope points $BROWSER at a tiny shim:
// - chrome: a new Chrome window on a fresh, throwaway profile, opened straight on
//           Claude's sign-in page; you sign in there yourself
// - system: your default browser (signed in to whatever account it already is)
// - none:   open nothing; Claude prints the URL to open yourself
// A fresh profile per login means two accounts never share cookies, the usual way the
// same account gets signed in twice. The sign-in is always completed by a person, in a
// normally launched browser: claude.ai's bot checks (Cloudflare, hCaptcha) are not
// something inscope or an agent should try to get past.
export const BROWSER_MODES = ["chrome", "system", "none"] as const

export type BrowserMode = (typeof BROWSER_MODES)[number]

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

// A Chromium-family browser binary to open the sign-in in. INSCOPE_CHROME overrides
// the search (another browser, or a test double).
export const findChrome = (): string | undefined => {
  const override = process.env.INSCOPE_CHROME?.trim()
  if (override) return fs.existsSync(override) ? override : undefined
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p))
}

export const defaultBrowserMode = (): BrowserMode => (findChrome() ? "chrome" : "system")

// Credential variables are dropped for every claude this runs, so the sign-in is always
// the claude.ai OAuth flow, its new token is never sent through a gateway, and the
// read-back sees the account's own login rather than an inherited token.
const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of CREDENTIAL_ENV_VARS) delete env[k]
  return env
}

const browserDir = () => path.join(accountsRoot(), ".browser")

// The throwaway Chrome profile a login's window runs on. It ends up holding that
// account's claude.ai web session, so it is deleted as soon as the login ends.
export const loginProfileDir = (name: string) => path.join(browserDir(), `${name}-profile`)

// Write the $BROWSER shim for a mode and return its path. The URL Claude passes is
// forwarded as one quoted argument, never interpolated into a command string; the
// Chrome binary, profile, port, and session arrive the same way, through env vars.
export const writeBrowserShim = (mode: Exclude<BrowserMode, "system">): string => {
  fs.mkdirSync(browserDir(), { recursive: true, mode: 0o700 })
  fs.chmodSync(browserDir(), 0o700)
  const file = path.join(browserDir(), `${mode}.sh`)
  const body =
    mode === "chrome"
      ? `#!/bin/sh
# inscope login: open Claude's sign-in page in a new Chrome window on a fresh profile
# (no other account's cookies); the person finishes the sign-in there.
rm -rf "$INSCOPE_LOGIN_PROFILE"
mkdir -p "$INSCOPE_LOGIN_PROFILE"
"$INSCOPE_LOGIN_CHROME" --user-data-dir="$INSCOPE_LOGIN_PROFILE" --no-first-run \\
  --no-default-browser-check --new-window "$1" >/dev/null 2>&1 &
echo $! > "$INSCOPE_LOGIN_PROFILE.pid"
exit 0
`
      : `#!/bin/sh
# inscope login: open nothing; claude prints the sign-in URL in the terminal.
exit 0
`
  writeFileAtomic(file, body)
  fs.chmodSync(file, 0o700)
  return file
}

// Open `url` in a new Chrome window on a fresh, throwaway profile for `name`, for a
// sign-in that does not go through $BROWSER (the proxy's own login prints its URL).
// Same profile and pid file as the $BROWSER shim, so closeWindow cleans up either.
export const openSignInWindow = (name: string, url: string): void => {
  const chrome = findChrome()
  if (!chrome)
    throw new Error("no Chrome-family browser found for the sign-in (set INSCOPE_CHROME)")
  closeWindow(name)
  const profile = loginProfileDir(name)
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
  const child = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      url,
    ],
    { detached: true, stdio: "ignore" },
  )
  child.unref()
  if (child.pid) writeFileAtomic(`${profile}.pid`, String(child.pid))
}

// Close the login window and delete its profile (and the claude.ai session in it).
export const closeWindow = (name: string) => {
  const profile = loginProfileDir(name)
  const pidFile = `${profile}.pid`
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
    if (pid > 0) process.kill(pid, "SIGTERM")
  } catch {}
  fs.rmSync(pidFile, { force: true })
  fs.rmSync(profile, { recursive: true, force: true })
}

export type LoginResult = { email: string; subscriptionType?: string }

export type LoginOptions = {
  name: string
  email?: string
  mode: BrowserMode
  // The accounts recorded right now, read when the sign-in completes (it can take
  // minutes), so the same Claude account is never signed in under two names.
  currentAccounts: () => { name: string; email?: string }[]
  // Whether `name` is already a recorded account (a re-login overwrites its token).
  existing?: boolean
  run?: Runner
  log?: (line: string) => void
}

// Sign `name` in through Claude Code's own `claude auth login`, with CLAUDE_CONFIG_DIR
// pinned to the account's dir, so Claude stores the token in that dir's own Keychain
// slot; inscope never handles the credential. Afterwards the effective login is read
// back with `claude auth status` (the check the old account pool never made) and
// rejected, and signed back out, if it is not the account that was asked for.
export const loginAccount = (opts: LoginOptions): LoginResult => {
  const run = opts.run ?? defaultRunner
  const log = opts.log ?? ((l: string) => console.log(l))
  const dir = accountDir(opts.name)
  fs.mkdirSync(accountsRoot(), { recursive: true, mode: 0o700 })
  fs.chmodSync(accountsRoot(), 0o700)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)

  const extra: Record<string, string> = { CLAUDE_CONFIG_DIR: dir }
  if (opts.mode === "chrome") {
    const chrome = findChrome()
    if (!chrome)
      throw new Error(
        "no Chrome-family browser found for the sign-in; use --browser system or none (or set INSCOPE_CHROME)",
      )
    closeWindow(opts.name) // a leftover window from an interrupted login
    extra.INSCOPE_LOGIN_CHROME = chrome
    extra.INSCOPE_LOGIN_PROFILE = loginProfileDir(opts.name)
  }
  if (opts.mode !== "system") extra.BROWSER = writeBrowserShim(opts.mode)

  // The email is never passed on (no --email/login_hint): you type it on the sign-in
  // page yourself. It is only checked against what signed in, below.
  const args = ["auth", "login"]
  let res: ReturnType<typeof spawnSync>
  try {
    res = spawnSync("claude", args, { stdio: "inherit", env: childEnv(extra) })
  } finally {
    if (opts.mode === "chrome") closeWindow(opts.name)
  }
  if (res.error) throw new Error(`could not run claude: ${res.error.message}`)
  if (res.status !== 0)
    throw new Error(`claude auth login exited with ${res.status}; nothing was saved`)

  const quiet = { unset: CREDENTIAL_ENV_VARS }
  const signOut = () =>
    run("claude", ["auth", "logout"], { env: { CLAUDE_CONFIG_DIR: dir }, ...quiet })
  // A failed check below leaves the account signed out; on a re-login that is the
  // recorded account itself, so say it needs signing in again.
  const after = opts.existing ? ` Account "${opts.name}" is now signed out; sign it in again.` : ""
  const auth = claudeAuthStatus(dir, run, quiet)
  if (!auth.signedIn || !auth.email) {
    signOut()
    throw new Error(
      `the sign-in did not complete (claude reports no login in ${dir}); nothing was saved.${after}`,
    )
  }
  if (opts.email && auth.email.toLowerCase() !== opts.email.toLowerCase()) {
    signOut()
    throw new Error(
      `signed in as ${auth.email}, not ${opts.email}; signed it back out.${after} Sign in with ${opts.email}.`,
    )
  }
  const dupe = opts
    .currentAccounts()
    .find((a) => a.name !== opts.name && a.email?.toLowerCase() === auth.email!.toLowerCase())
  if (dupe) {
    signOut()
    throw new Error(
      `${auth.email} is already account "${dupe.name}"; signed this one back out.${after} Sign in with a different Claude account.`,
    )
  }
  log(`signed in as ${auth.email}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ""}`)
  return { email: auth.email, subscriptionType: auth.subscriptionType }
}

// Sign an account out through Claude Code (which deletes its Keychain token). The
// dir itself, with that login's history, is left for the user to delete.
export const logoutAccount = (name: string, run: Runner = defaultRunner): boolean =>
  run("claude", ["auth", "logout"], {
    env: { CLAUDE_CONFIG_DIR: accountDir(name) },
    unset: CREDENTIAL_ENV_VARS,
  }).status === 0
