import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { inscopeHome } from "@/env"
import { writeFileAtomic } from "@/io"

// Where `inscope login` opens Claude's sign-in page (the proxy's own sign-in prints it):
// - chrome: a new Chrome window on a fresh, throwaway profile, opened straight on
//           Claude's sign-in page; you sign in there yourself
// - system: your default browser (signed in to whatever account it already is)
// - none:   open nothing; the URL is printed to open yourself
// A fresh profile per sign-in means two accounts never share cookies, the usual way the
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

// Variables that would make a process skip the subscription sign-in (an API key or an
// injected OAuth token) or send it elsewhere (a gateway). Dropped for the proxy's
// sign-in, so it is always the claude.ai OAuth flow.
export const CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
]

export const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of CREDENTIAL_ENV_VARS) delete env[k]
  return env
}

const browserDir = () => path.join(inscopeHome(), "browser")

// The throwaway Chrome profile a login's window runs on. It ends up holding that
// account's claude.ai web session, so it is deleted as soon as the login ends.
export const loginProfileDir = (name: string) => path.join(browserDir(), `${name}-profile`)

// Open `url` in a new Chrome window on a fresh, throwaway profile for `name`, for a
// sign-in (the proxy's own sign-in prints its URL). closeWindow cleans it up.
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
// Chrome keeps writing into its profile for a moment after SIGTERM, so wait for it to
// exit before removing the profile, and never fail a sign-in over cleanup: a profile
// left behind is removed when the next sign-in starts.
export const closeWindow = (name: string) => {
  const profile = loginProfileDir(name)
  const pidFile = `${profile}.pid`
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
    if (pid > 0) {
      process.kill(pid, "SIGTERM")
      const until = Date.now() + 5000
      while (Date.now() < until && isRunning(pid)) sleepSync(100)
    }
  } catch {}
  try {
    fs.rmSync(pidFile, { force: true })
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {}
}

// Whether a process is still running. A browser this process launched stays a zombie
// after it exits (nothing reaps it while closeWindow waits), so ask ps for its state.
const isRunning = (pid: number) => {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  return r.status === 0 && !r.stdout.trim().startsWith("Z")
}

export const sleepSync = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
