import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { type FetchLike, fetchUsage, keychainServiceFor, planLabel } from "@/accounts"
import { type Config, validateConfig } from "@/config"
import { resetsIn } from "@/usage"
import { loginChoices, resolveLoginFlags } from "~/bin/commands/_workspace"

import { startAnthropicEmulator } from "./support/anthropic-emulator"

// --- unit: the Keychain slot name ---------------------------------------------------

test("keychainServiceFor matches the slots Claude Code actually created on this Mac", () => {
  // Observed in the login Keychain on 2026-10-10 (Claude Code 2.1.294): ~/.claude ran
  // with CLAUDE_CONFIG_DIR=/Users/nrjdalal/.claude, and an isolated workspace login.
  expect(keychainServiceFor("/Users/nrjdalal/.claude")).toBe("Claude Code-credentials-d7f60465")
  expect(keychainServiceFor("/Users/nrjdalal/Desktop/lwai/.inscope")).toBe(
    "Claude Code-credentials-cbde437b",
  )
  // the literal string, no normalization of a trailing slash or symlink
  expect(keychainServiceFor("/Users/nrjdalal/.claude/")).not.toBe(
    keychainServiceFor("/Users/nrjdalal/.claude"),
  )
})

test("planLabel reads the Max multiplier from the tier, else the subscription", () => {
  expect(planLabel({ rateLimitTier: "default_claude_max_20x", subscriptionType: "max" })).toBe(
    "max 20x",
  )
  expect(planLabel({ rateLimitTier: "default_claude_max_5x" })).toBe("max 5x")
  expect(planLabel({ subscriptionType: "pro" })).toBe("pro")
  expect(planLabel(null)).toBeUndefined()
})

test("resetsIn formats the time left until a reset", () => {
  const now = Date.parse("2026-10-10T12:00:00Z")
  expect(resetsIn("2026-10-10T14:05:00Z", now)).toBe("2h 05m")
  expect(resetsIn("2026-10-13T16:00:00Z", now)).toBe("3d 4h")
  expect(resetsIn("2026-10-10T12:20:00Z", now)).toBe("20m")
  expect(resetsIn("2026-10-10T11:00:00Z", now)).toBe("now")
  expect(resetsIn(null, now)).toBe("")
  expect(resetsIn("not a date", now)).toBe("")
})

// --- unit: config validation --------------------------------------------------------

const cfgWith = (over: Partial<Config>): Config => ({ version: 1, workspaces: [], ...over })

test("validateConfig accepts accounts and a workspace that runs on one", () => {
  expect(() =>
    validateConfig(
      cfgWith({
        accounts: [{ name: "work", email: "w@x.dev" }],
        workspaces: [{ name: "acme", path: "~/acme", servers: {}, account: "work" }],
      }),
    ),
  ).not.toThrow()
})

test("validateConfig rejects bad accounts and bad account references", () => {
  const bad: [Partial<Config>, string][] = [
    [{ accounts: [{ name: ".hidden" }] }, "must not start with a dot"],
    [{ accounts: [{ name: "a b" }] }, "use only letters"],
    [{ accounts: [{ name: "a" }, { name: "a" }] }, 'duplicate account name "a"'],
    [{ accounts: [{ name: "a", email: "x\ny" }] }, "must not contain a newline"],
    [{ accounts: "nope" as never }, "config.accounts must be an array"],
    [
      { workspaces: [{ name: "acme", path: "~/acme", servers: {}, account: "ghost" }] },
      'uses account "ghost", which does not exist',
    ],
    [
      {
        accounts: [{ name: "work" }],
        workspaces: [{ name: "acme", path: "~/acme", servers: {}, account: "work", isolate: true }],
      },
      "sets both isolate and account",
    ],
  ]
  for (const [over, msg] of bad) expect(() => validateConfig(cfgWith(over))).toThrow(msg)
})

// --- unit: the add/edit login choice ------------------------------------------------

test("resolveLoginFlags: an account replaces isolation, and the reverse, and none clears it", () => {
  expect(resolveLoginFlags({ account: "work" }, { isolate: true })).toEqual({
    isolate: false,
    account: "work",
  })
  expect(resolveLoginFlags({ isolate: true }, { isolate: false, account: "work" })).toEqual({
    isolate: true,
    account: undefined,
  })
  expect(resolveLoginFlags({ account: "none" }, { isolate: false, account: "work" })).toEqual({
    isolate: false,
    account: undefined,
  })
  expect(resolveLoginFlags({}, { isolate: false, account: "work" })).toEqual({
    isolate: false,
    account: "work",
  })
  expect(resolveLoginFlags({ isolate: false }, { isolate: true })).toEqual({
    isolate: false,
    account: undefined,
  })
})

test("loginChoices offers shared, isolated, then each account, preselecting the current one", () => {
  const accounts = [{ name: "a", email: "a@x.dev" }, { name: "b" }]
  const { choices, initial } = loginChoices(accounts, { isolate: false, account: "b" })
  expect(choices.map((c) => c.label)).toEqual([
    "shared (your base login)",
    "isolated (its own login in .inscope)",
    "account a (a@x.dev)",
    "account b",
  ])
  expect(initial).toBe(3)
  expect(loginChoices(accounts, { isolate: true }).initial).toBe(1)
  expect(loginChoices(accounts, { isolate: false }).initial).toBe(0)
})

// --- unit: the usage endpoint client ------------------------------------------------

const fakeFetch =
  (status: number, body: unknown, throws?: Error): FetchLike =>
  async () => {
    if (throws) throw throws
    return { status, json: async () => body }
  }

test("fetchUsage maps the endpoint's answers to ok, expired, rate-limited, or error", async () => {
  const ok = await fetchUsage(
    "t",
    fakeFetch(200, {
      five_hour: { utilization: 12.5, resets_at: "2026-10-10T14:00:00Z" },
      seven_day: { utilization: 80, resets_at: "2026-10-12T00:00:00Z" },
    }),
  )
  expect(ok).toEqual({
    ok: true,
    fiveHour: { percent: 12.5, resetsAt: "2026-10-10T14:00:00Z" },
    week: { percent: 80, resetsAt: "2026-10-12T00:00:00Z" },
  })
  expect(await fetchUsage("t", fakeFetch(401, {}))).toMatchObject({ ok: false, reason: "expired" })
  expect(await fetchUsage("t", fakeFetch(429, {}))).toMatchObject({
    ok: false,
    reason: "rate-limited",
  })
  expect(await fetchUsage("t", fakeFetch(500, {}))).toMatchObject({ ok: false, reason: "error" })
  expect(await fetchUsage("t", fakeFetch(200, {}))).toMatchObject({
    ok: false,
    detail: "usage endpoint returned no 5h or weekly window",
  })
  expect(await fetchUsage("t", fakeFetch(200, null))).toMatchObject({ ok: false, reason: "error" })
  expect(await fetchUsage("t", fakeFetch(0, null, new Error("ECONNREFUSED")))).toMatchObject({
    ok: false,
    detail: "request failed: ECONNREFUSED",
  })
  // a partial answer keeps the window it has
  expect(
    await fetchUsage("t", fakeFetch(200, { five_hour: null, seven_day: { utilization: 5 } })),
  ).toEqual({ ok: true, fiveHour: null, week: { percent: 5, resetsAt: null } })
})

// --- the real CLI against fake claude/security/agent-browser ------------------------

const FAKES = path.join(import.meta.dir, "support", "bin")
const ENTRY = path.join(import.meta.dir, "..", "bin", "index.ts")
const hasZsh = (() => {
  try {
    return spawnSync("zsh", ["--version"]).status === 0
  } catch {
    return false
  }
})()

const sandbox = () => {
  const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inscope-acct-")))
  const state = path.join(sb, ".fake")
  fs.mkdirSync(state)
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${FAKES}:${process.env.PATH}`,
    HOME: sb,
    XDG_CONFIG_HOME: path.join(sb, ".config"),
    GH_CONFIG_DIR: path.join(sb, ".gh"),
    FAKE_SANDBOX: sb,
    FAKE_STATE: state,
  }
  for (const k of [
    "CLAUDE_CONFIG_DIR",
    "INSCOPE_CCD",
    "INSCOPE_BASE_CCD",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "BROWSER",
    "NODE_OPTIONS",
  ])
    delete env[k]
  const cli = (args: string[], extra: Record<string, string> = {}, cwd?: string) =>
    spawnSync("bun", [ENTRY, ...args], { encoding: "utf8", env: { ...env, ...extra }, cwd })
  // Async, for commands that call the in-process emulator: spawnSync would block the
  // event loop the emulator answers on.
  const cliAsync = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("bun", [ENTRY, ...args], { env: { ...env, ...extra } })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("close", (status) => resolve({ status, stdout, stderr }))
    })
  const cfgFile = path.join(sb, ".config", "inscope", "inscope.json")
  const readCfg = (): Config | null =>
    fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : null
  const writeCfg = (cfg: Config) => {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n")
  }
  const keychain = (): Record<string, string> => {
    const f = path.join(state, "keychain.json")
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}
  }
  const setKeychain = (k: Record<string, string>) =>
    fs.writeFileSync(path.join(state, "keychain.json"), JSON.stringify(k, null, 2))
  const calls = (tool: "claude" | "agent-browser"): any[] => {
    const f = path.join(state, `${tool}-calls.jsonl`)
    return fs.existsSync(f)
      ? fs
          .readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : []
  }
  const accountDir = (n: string) => path.join(sb, ".config", "inscope", "accounts", n)
  // run the fake claude directly (e.g. to sign the base login in)
  const fakeClaude = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(path.join(FAKES, "claude"), args, { encoding: "utf8", env: { ...env, ...extra } })
  return {
    sb,
    env,
    cli,
    cliAsync,
    readCfg,
    writeCfg,
    keychain,
    setKeychain,
    calls,
    accountDir,
    fakeClaude,
  }
}

test("CLI: login signs an account in through claude auth login, in an isolated agent-browser session", () => {
  const s = sandbox()
  const r = s.cli(["login", "work", "--email", "w@x.dev"], { FAKE_LOGIN_EMAIL: "w@x.dev" })
  expect(r.stderr).toBe("")
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('✓ account "work" -> w@x.dev')
  expect(s.readCfg()?.accounts).toEqual([{ name: "work", email: "w@x.dev" }])

  const dir = s.accountDir("work")
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  const login = s.calls("claude").find((c) => c.args[1] === "login")
  expect(login.args).toEqual(["auth", "login", "--email", "w@x.dev"])
  expect(login.ccd).toBe(dir)
  expect(login.browser).toBe(
    path.join(s.sb, ".config", "inscope", "accounts", ".browser", "agent.sh"),
  )

  // a fresh, visible session opened the sign-in URL, and was closed afterwards
  const ab = s.calls("agent-browser")
  const open = ab.find((a: string[]) => a.includes("open"))
  expect(open.slice(0, 4)).toEqual(["--session", open[1], "--headed", "open"])
  expect(open[1]).toBe("inscope-login-work")
  expect(r.stdout).toContain("agent-browser session: inscope-login-work")
  // a stale window from an interrupted login is closed before this one opens
  expect(
    ab.findIndex((a: string[]) => a.join(" ") === "--session inscope-login-work close"),
  ).toBeLessThan(ab.indexOf(open))
  expect(open[4]).toContain("login_hint=w%40x.dev")
  expect(ab).toContainEqual(["--session", open[1], "close"])

  // the token sits in the slot Claude derives from that exact dir string, which the fake
  // computed on its own: inscope and Claude agree on the slot
  expect(Object.keys(s.keychain())).toEqual([keychainServiceFor(dir)])
})

test("CLI: login rejects a different account than --email and signs it back out", () => {
  const s = sandbox()
  const r = s.cli(["login", "work", "--email", "w@x.dev"], { FAKE_BROWSER_EMAIL: "other@x.dev" })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain("signed in as other@x.dev, not w@x.dev; signed it back out")
  expect(s.readCfg()).toBeNull()
  expect(s.keychain()).toEqual({})
})

test("CLI: login refuses the same Claude account under a second name", () => {
  const s = sandbox()
  expect(s.cli(["login", "a"], { FAKE_LOGIN_EMAIL: "a@x.dev" }).status).toBe(0)
  const r = s.cli(["login", "b"], { FAKE_LOGIN_EMAIL: "A@x.dev" })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('A@x.dev is already account "a"')
  expect(s.readCfg()?.accounts).toEqual([{ name: "a", email: "a@x.dev" }])
  expect(Object.keys(s.keychain())).toEqual([keychainServiceFor(s.accountDir("a"))])
})

test("CLI: login re-signs an existing account in, keeping its recorded email as the expectation", () => {
  const s = sandbox()
  expect(s.cli(["login", "a"], { FAKE_LOGIN_EMAIL: "a@x.dev" }).status).toBe(0)
  const wrong = s.cli(["login", "a"], { FAKE_LOGIN_EMAIL: "z@x.dev" })
  expect(wrong.status).toBe(1)
  expect(wrong.stderr).toContain("signed in as z@x.dev, not a@x.dev")
  expect(s.cli(["login", "a"], { FAKE_LOGIN_EMAIL: "a@x.dev" }).status).toBe(0)
  expect(s.readCfg()?.accounts).toEqual([{ name: "a", email: "a@x.dev" }])
})

test("CLI: login --browser none and system never touch agent-browser", () => {
  const s = sandbox()
  const none = s.cli(["login", "a", "--browser", "none"], { FAKE_LOGIN_EMAIL: "a@x.dev" })
  expect(none.status).toBe(0)
  expect(none.stdout).toContain("If the browser didn't open, visit: https://claude.com/cai/oauth")
  const sys = s.cli(["login", "b", "--browser", "system"], { FAKE_LOGIN_EMAIL: "b@x.dev" })
  expect(sys.status).toBe(0)
  const [c1, c2] = s.calls("claude").filter((c) => c.args[1] === "login")
  expect(c1.browser).toBe(path.join(s.sb, ".config", "inscope", "accounts", ".browser", "none.sh"))
  expect(c2.browser).toBeNull() // system: $BROWSER left as the user had it (unset here)
  expect(s.calls("agent-browser")).toEqual([])
  expect(s.cli(["login", "c", "--browser", "lynx"]).stderr).toContain(
    'Invalid --browser "lynx": use agent, system, none',
  )
})

test("CLI: login saves nothing when the sign-in fails", () => {
  const s = sandbox()
  const r = s.cli(["login", "a"], { FAKE_LOGIN_FAIL: "1", FAKE_LOGIN_EMAIL: "a@x.dev" })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain("claude auth login exited with 1; nothing was saved")
  expect(s.readCfg()).toBeNull()
  expect(s.cli(["login", ".bad"]).stderr).toContain('Invalid account name ".bad"')
})

test("CLI: add --account runs a workspace on a signed-in account; --isolate and none switch it", () => {
  const s = sandbox()
  const ws = path.join(s.sb, "acme")
  fs.mkdirSync(ws)
  const missing = s.cli(["add", ws, "--account", "work", "-y"])
  expect(missing.status).toBe(1)
  expect(missing.stderr).toContain('No account named "work". Sign it in first: inscope login work')

  expect(s.cli(["login", "work"], { FAKE_LOGIN_EMAIL: "w@x.dev" }).status).toBe(0)
  const added = s.cli(["add", ws, "--account", "work", "-y"])
  expect(added.status).toBe(0)
  expect(added.stdout).toContain("it runs on account work")
  const wsOf = () => s.readCfg()!.workspaces.find((w) => w.name === "acme")!
  expect(wsOf().account).toBe("work")
  expect(fs.existsSync(path.join(ws, ".inscope"))).toBe(false)

  expect(s.cli(["add", ws, "--isolate", "-y"]).status).toBe(0)
  expect([wsOf().isolate, wsOf().account]).toEqual([true, undefined])
  expect(s.cli(["add", ws, "--account", "work", "-y"]).status).toBe(0)
  expect([wsOf().isolate, wsOf().account]).toEqual([undefined, "work"])
  expect(s.cli(["add", ws, "--account", "none", "-y"]).status).toBe(0)
  expect([wsOf().isolate, wsOf().account]).toEqual([undefined, undefined])
})

test.skipIf(!hasZsh)(
  "CLI + zsh: the hook exports the account's exact dir, and claude reads that account's login there",
  () => {
    // The regression the old account pool never tested: the effective login, not a file.
    const s = sandbox()
    const ws = path.join(s.sb, "acme")
    const other = path.join(s.sb, "elsewhere")
    fs.mkdirSync(ws)
    fs.mkdirSync(other)
    expect(s.cli(["login", "work"], { FAKE_LOGIN_EMAIL: "w@x.dev" }).status).toBe(0)
    expect(s.cli(["login", "play"], { FAKE_LOGIN_EMAIL: "p@x.dev" }).status).toBe(0)
    expect(s.cli(["add", ws, "--account", "work", "-y"]).status).toBe(0)
    const hook = path.join(s.sb, ".config", "inscope", "inscope.zsh")
    const probe = (dir: string) =>
      spawnSync(
        "zsh",
        [
          "-f",
          "-c",
          `source ${JSON.stringify(hook)}; cd ${JSON.stringify(dir)}; print -r -- "$CLAUDE_CONFIG_DIR"; claude auth status --json`,
        ],
        { encoding: "utf8", env: s.env as NodeJS.ProcessEnv },
      )
    const inWs = probe(ws)
    expect(inWs.stderr).toBe("")
    const [ccd, status] = inWs.stdout.trim().split("\n")
    expect(ccd).toBe(s.accountDir("work"))
    expect(JSON.parse(status)).toMatchObject({ loggedIn: true, email: "w@x.dev" })

    // moving the workspace to the other account is one flag; the next shell picks it up
    expect(s.cli(["add", ws, "--account", "play", "-y"]).status).toBe(0)
    const moved = probe(ws).stdout.trim().split("\n")
    expect(moved[0]).toBe(s.accountDir("play"))
    expect(JSON.parse(moved[1])).toMatchObject({ email: "p@x.dev" })

    // outside it, back on the base login
    expect(probe(other).stdout.trim().split("\n")[0]).toBe(path.join(s.sb, ".claude"))
  },
)

test("CLI: logout refuses while a workspace uses the account, then signs it out", () => {
  const s = sandbox()
  const ws = path.join(s.sb, "acme")
  fs.mkdirSync(ws)
  expect(s.cli(["login", "work"], { FAKE_LOGIN_EMAIL: "w@x.dev" }).status).toBe(0)
  expect(s.cli(["add", ws, "--account", "work", "-y"]).status).toBe(0)
  const busy = s.cli(["logout", "work"])
  expect(busy.status).toBe(1)
  expect(busy.stderr).toContain('Account "work" is used by acme')
  expect(s.cli(["add", ws, "--account", "none", "-y"]).status).toBe(0)
  const out = s.cli(["logout", "work"])
  expect(out.status).toBe(0)
  expect(out.stdout).toContain('signed out and removed account "work"')
  expect(s.readCfg()?.accounts).toBeUndefined()
  expect(s.keychain()).toEqual({})
  expect(fs.existsSync(s.accountDir("work"))).toBe(true) // history left in place
  expect(s.cli(["logout", "ghost"]).stderr).toContain('No account named "ghost"')
})

test("CLI: status, list, and doctor show the account a workspace runs on", () => {
  const s = sandbox()
  const ws = path.join(s.sb, "acme")
  fs.mkdirSync(ws)
  expect(s.cli(["login", "work"], { FAKE_LOGIN_EMAIL: "w@x.dev" }).status).toBe(0)
  expect(s.cli(["add", ws, "--account", "work", "-y"]).status).toBe(0)
  const st = s.cli(["status"], {}, ws)
  expect(st.stdout).toContain("Claude  account work · w@x.dev · max")
  expect(st.stdout).toContain("~/.config/inscope/accounts/work")
  expect(s.cli(["list"]).stdout).toContain("claude   account work")
  expect(JSON.parse(s.cli(["list", "--json"]).stdout)[0].account).toBe("work")
  const doc = s.cli(["doctor"])
  expect(doc.stdout).toContain("[account work]")
  expect(doc.stdout).toContain("w@x.dev · max · used by acme")
  expect(doc.stdout).toContain("[acme] claude")
  // signed out behind inscope's back: doctor fails it
  s.setKeychain({})
  expect(s.cli(["doctor"]).stdout).toContain(
    "not signed in at ~/.config/inscope/accounts/work; run `inscope login work`",
  )
})

test("CLI: bypass reaches every account login, and skills on an account are shared and pruned", () => {
  const s = sandbox()
  const a = path.join(s.sb, "a")
  const b = path.join(s.sb, "b")
  const mk = (n: string) => {
    const d = path.join(s.sb, "skills-src", n)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${n}\ndescription: d\n---\n`)
    return d
  }
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  const sa = mk("alpha")
  const sb2 = mk("beta")
  expect(s.cli(["login", "work"], { FAKE_LOGIN_EMAIL: "w@x.dev" }).status).toBe(0)
  expect(s.cli(["login", "idle"], { FAKE_LOGIN_EMAIL: "i@x.dev" }).status).toBe(0)
  const cfg = s.readCfg()!
  s.writeCfg({
    ...cfg,
    bypass: true,
    workspaces: [
      { name: "a", path: a, servers: {}, account: "work", skills: [sa], selfSkill: false },
      { name: "b", path: b, servers: {}, account: "work", skills: [sb2], selfSkill: false },
    ],
  })
  const ap = s.cli(["apply"])
  expect(ap.stderr).toBe("")
  for (const acc of ["work", "idle"]) {
    const settings = JSON.parse(
      fs.readFileSync(path.join(s.accountDir(acc), "settings.json"), "utf8"),
    )
    expect(settings.permissions.defaultMode).toBe("bypassPermissions")
  }
  const skills = path.join(s.accountDir("work"), "skills")
  expect(fs.readdirSync(skills).sort()).toEqual(["alpha", "beta"])

  // both workspaces leave the account: its links are pruned on the next apply
  s.writeCfg({
    ...s.readCfg()!,
    workspaces: s.readCfg()!.workspaces.map(({ account: _a, ...w }) => w),
  })
  expect(s.cli(["apply"]).status).toBe(0)
  expect(fs.readdirSync(skills)).toEqual([])
})

// --- usage against the Anthropic emulator -------------------------------------------

let emu: Awaited<ReturnType<typeof startAnthropicEmulator>>
const FIVE = "2099-01-01T00:00:00Z"
beforeAll(async () => {
  emu = await startAnthropicEmulator({
    "tok-base@x.dev": { kind: "ok", fiveHour: 4, week: 61, fiveHourResets: FIVE, weekResets: FIVE },
    "tok-w@x.dev": { kind: "ok", fiveHour: 37, week: 92, fiveHourResets: FIVE, weekResets: FIVE },
    "tok-p@x.dev": { kind: "ok", fiveHour: 0, week: 10, fiveHourResets: FIVE, weekResets: FIVE },
    "tok-r@x.dev": { kind: "status", status: 429 },
    "tok-d@x.dev": { kind: "shape", body: { renamed: true } },
  })
})
afterAll(() => emu?.close())

const expireToken = (s: ReturnType<typeof sandbox>, dir: string) => {
  const k = s.keychain()
  const svc = keychainServiceFor(dir)
  const doc = JSON.parse(k[svc])
  doc.claudeAiOauth.expiresAt = Date.now() - 3600_000
  k[svc] = JSON.stringify(doc)
  s.setKeychain(k)
}

test("CLI: usage reads each login's 5-hour and weekly usage, read-only, and never sends an expired token", async () => {
  const s = sandbox()
  // the base login, signed in the way the hook runs it (CLAUDE_CONFIG_DIR=$HOME/.claude)
  expect(
    s.fakeClaude(["auth", "login"], {
      FAKE_LOGIN_EMAIL: "base@x.dev",
      CLAUDE_CONFIG_DIR: path.join(s.sb, ".claude"),
    }).status,
  ).toBe(0)
  for (const [n, e] of [
    ["work", "w@x.dev"],
    ["play", "p@x.dev"],
    ["rl", "r@x.dev"],
    ["drift", "d@x.dev"],
  ])
    expect(s.cli(["login", n], { FAKE_LOGIN_EMAIL: e }).status).toBe(0)
  const ws = path.join(s.sb, "acme")
  fs.mkdirSync(ws)
  expect(s.cli(["add", ws, "--account", "work", "-y"]).status).toBe(0)
  expireToken(s, s.accountDir("play"))
  const before = s.keychain()
  const seen = emu.requests().length

  const r = await s.cliAsync(["usage", "--json"], { INSCOPE_ANTHROPIC_API_URL: emu.url })
  expect(r.stderr).toBe("")
  const rows = JSON.parse(r.stdout)
  const by = Object.fromEntries(rows.map((x: any) => [x.login, x]))
  expect(by.base).toMatchObject({ state: "ok", email: "base@x.dev", plan: "max 20x" })
  expect(by.base.fiveHour).toEqual({ percent: 4, resetsAt: FIVE })
  expect(by.work).toMatchObject({ state: "ok", usedBy: ["acme"], weekly: { percent: 92 } })
  expect(by.play).toMatchObject({ state: "expired", email: "p@x.dev" })
  expect(by.rl).toMatchObject({ state: "rate-limited" })
  expect(by.drift).toMatchObject({
    state: "error",
    detail: "usage endpoint returned no 5h or weekly window",
  })

  // the right headers, and the expired token never left the machine
  const sent = emu.requests().slice(seen)
  expect(sent.every((q) => q.beta === "oauth-2025-04-20")).toBe(true)
  expect(sent.map((q) => q.authorization).sort()).toEqual(
    ["base@x.dev", "d@x.dev", "r@x.dev", "w@x.dev"].map((e) => `Bearer tok-${e}`).sort(),
  )
  // read-only: no token was touched
  expect(s.keychain()).toEqual(before)

  const table = (await s.cliAsync(["usage"], { INSCOPE_ANTHROPIC_API_URL: emu.url })).stdout
  expect(table).toContain("LOGIN")
  expect(table).toMatch(/work\s+w@x\.dev\s+max 20x\s+37% · \d+d \d+h\s+92% · \d+d \d+h\s+acme/)
  expect(table).toMatch(/play\s+p@x\.dev\s+max 20x\s+expired\s+-\s+-/)
  expect(table).toContain("expired (play): run `inscope usage --refresh`, or use that login once")
  expect(table).toContain("unavailable (drift): usage endpoint returned no 5h or weekly window")
}, 30_000)

test("CLI: usage --refresh lets Claude Code refresh an expired login, then reads it", async () => {
  const s = sandbox()
  expect(s.cli(["login", "play"], { FAKE_LOGIN_EMAIL: "p@x.dev" }).status).toBe(0)
  expireToken(s, s.accountDir("play"))
  const r = await s.cliAsync(["usage", "--json", "--refresh"], {
    INSCOPE_ANTHROPIC_API_URL: emu.url,
  })
  expect(r.stderr).toContain("refreshing play...")
  const play = JSON.parse(r.stdout).find((x: any) => x.login === "play")
  expect(play).toMatchObject({ state: "ok", weekly: { percent: 10 } })
  const refresh = s.calls("claude").find((c) => c.args[0] === "-p")
  expect(refresh.ccd).toBe(s.accountDir("play"))
  expect(refresh.args).toEqual(["-p", "Reply with the single word: ok", "--model", "haiku"])
}, 30_000)
