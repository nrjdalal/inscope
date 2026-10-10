import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { type Config, validateConfig } from "@/config"
import { poolAfterChange, PROXY_VERSION, routeFor } from "@/proxy"

import { startMessagesEmulator } from "./support/anthropic-messages-emulator"
import { sandbox } from "./support/sandbox"

// Pools: each is its own proxy on its own port, and a pooled isolated workspace routes
// to its pool while the shared login and every other workspace stay on the default.

// --- unit -----------------------------------------------------------------------------

const ws = (over: Record<string, unknown> = {}) => ({
  name: "w",
  path: "/w",
  servers: {},
  ...over,
})

test("validateConfig guards pools and a workspace's pool", () => {
  const base = { version: 1, proxy: { port: 8317 } }
  const ok = (cfg: unknown) => expect(() => validateConfig(cfg as Config)).not.toThrow()
  const bad = (cfg: unknown, msg: string) =>
    expect(() => validateConfig(cfg as Config)).toThrow(msg)
  ok({
    ...base,
    pools: [{ name: "work", port: 8318 }],
    workspaces: [ws({ isolate: true, pool: "work" })],
  })
  bad(
    { ...base, pools: [{ name: "Work", port: 8318 }], workspaces: [] },
    'pool name "Work" is invalid',
  )
  bad(
    { ...base, pools: [{ name: "default", port: 8318 }], workspaces: [] },
    '"default" is the default pool',
  )
  bad(
    {
      ...base,
      pools: [
        { name: "a", port: 8318 },
        { name: "a", port: 8319 },
      ],
      workspaces: [],
    },
    'duplicate pool "a"',
  )
  bad({ ...base, pools: [{ name: "a", port: 8317 }], workspaces: [] }, "port 8317 is already used")
  bad({ ...base, pools: [{ name: "a", port: 80 }], workspaces: [] }, "between 1024 and 65535")
  bad({ version: 1, pools: [{ name: "a", port: 8318 }], workspaces: [] }, "need the default pool")
  bad(
    { ...base, pools: [{ name: "work", port: 8318 }], workspaces: [ws({ pool: "work" })] },
    "pool requires isolate: true",
  )
  bad(
    { ...base, workspaces: [ws({ isolate: true, pool: "nope" })] },
    'uses pool "nope", which does not exist',
  )
})

test("routeFor sends a pooled isolated workspace to its pool, everything else to the default", () => {
  const cfg: Config = {
    version: 1,
    proxy: { port: 8317 },
    pools: [{ name: "work", port: 8318 }],
    workspaces: [],
  }
  expect(routeFor(cfg)?.url).toBe("http://127.0.0.1:8317")
  expect(routeFor(cfg, ws({ isolate: true, pool: "work" }) as any)?.url).toBe(
    "http://127.0.0.1:8318",
  )
  expect(routeFor(cfg, ws({ isolate: true }) as any)?.url).toBe("http://127.0.0.1:8317")
  expect(routeFor({ ...cfg, proxy: undefined, pools: undefined })).toBeUndefined()
})

test("poolAfterChange: --pool sets it, default clears it, and losing isolation drops it", () => {
  const cfg: Config = {
    version: 1,
    proxy: { port: 8317 },
    pools: [{ name: "work", port: 8318 }],
    workspaces: [],
  }
  const pooled = ws({ isolate: true, pool: "work" }) as any
  expect(poolAfterChange(cfg, undefined, true, "work")).toEqual({ pool: "work" })
  expect(poolAfterChange(cfg, pooled, true, "default")).toEqual({ pool: undefined })
  expect(poolAfterChange(cfg, pooled, true)).toEqual({ pool: "work" })
  expect(poolAfterChange(cfg, pooled, false)).toEqual({
    pool: undefined,
    note: "Note: this workspace left pool work; a pool needs a separate Claude config, so it uses the default pool now.",
  })
  expect(() => poolAfterChange(cfg, undefined, true, "nope")).toThrow(
    "No pool nope. Create it by signing an account in to it: inscope login --pool nope",
  )
})

// --- the real CLI, in a sandbox HOME --------------------------------------------------------

// A stand-in proxy binary "installed" in the sandbox, fake launchctl and security on PATH,
// and one Messages emulator per pool port answering the health checks.
const FAKE_PROXY = path.join(import.meta.dir, "support", "fake-proxy", "cli-proxy-api")
let one: Awaited<ReturnType<typeof startMessagesEmulator>>
let two: Awaited<ReturnType<typeof startMessagesEmulator>>
beforeAll(async () => {
  one = await startMessagesEmulator({})
  two = await startMessagesEmulator({})
})
afterAll(() => {
  one?.close()
  two?.close()
})

const poolSandbox = () => {
  const s = sandbox()
  const bin = path.join(s.sb, ".config", "inscope", "proxy", "bin", PROXY_VERSION, "cli-proxy-api")
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.copyFileSync(FAKE_PROXY, bin)
  fs.chmodSync(bin, 0o755)
  const p1 = Number(new URL(one.url).port)
  const p2 = Number(new URL(two.url).port)
  const work = path.join(s.sb, "work")
  const iso = path.join(s.sb, "iso")
  fs.mkdirSync(work)
  fs.mkdirSync(iso)
  s.writeCfg({
    version: 1,
    workspaces: [
      { isolate: true, name: "iso", path: iso, servers: {} },
      { isolate: true, name: "work", path: work, servers: {} },
    ],
  })
  const login = (email: string, args: string[] = [], extra: Record<string, string> = {}) =>
    s.cliAsync(["login", "--browser", "none", ...args], { FAKE_LOGIN_EMAIL: email, ...extra })
  const url = (dir: string) => {
    const f = path.join(dir, "settings.json")
    return fs.existsSync(f)
      ? JSON.parse(fs.readFileSync(f, "utf8")).env?.ANTHROPIC_BASE_URL
      : undefined
  }
  const poolDir = path.join(s.sb, ".config", "inscope", "proxy", "pools", "work")
  const agent = (label: string) => path.join(s.sb, "Library", "LaunchAgents", `${label}.plist`)
  const loaded = (label: string) =>
    fs.existsSync(path.join(s.sb, ".fake", `launchctl-loaded-${label}`))
  return {
    s,
    p1,
    p2,
    work,
    iso,
    login,
    url,
    poolDir,
    agent,
    loaded,
    base: path.join(s.sb, ".claude"),
  }
}

test("CLI: login --pool creates a pool on its own proxy, and only its workspace routes to it", async () => {
  const { s, p1, p2, work, iso, login, url, poolDir, agent, loaded, base } = poolSandbox()
  // a named pool needs the default pool first
  const early = await login("w1@x.dev", ["--pool", "work", "--port", String(p2)])
  expect(early.status).toBe(1)
  expect(early.stderr).toContain("Sign an account in to the default pool first")

  expect((await login("me@x.dev", ["--port", String(p1)])).status).toBe(0)
  const first = await login("w1@x.dev", ["--pool", "work", "--port", String(p2)])
  expect(first.stderr).toBe("")
  expect(first.status).toBe(0)
  expect(first.stdout).toContain(`pool work (http://127.0.0.1:${p2}) holds 1 account`)
  expect(s.readCfg()?.pools).toEqual([{ name: "work", port: p2 }])
  // its own proxy: config, owner-only token, and launchd agent
  expect(fs.statSync(path.join(poolDir, "config.yaml")).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(path.join(poolDir, "config.yaml"), "utf8")).toContain(`port: ${p2}\n`)
  expect(fs.statSync(path.join(poolDir, "auth", "claude-w1@x.dev.json")).mode & 0o777).toBe(0o600)
  expect(fs.existsSync(agent("dev.inscope.proxy.work"))).toBe(true)
  expect(loaded("dev.inscope.proxy.work")).toBe(true)
  expect(loaded("dev.inscope.proxy")).toBe(true)

  // a second account joins the running pool without setting it up again
  const boots = s.calls("launchctl").filter((c) => c[0] === "bootstrap").length
  expect((await login("w2@x.dev", ["--pool", "work"])).status).toBe(0)
  expect(s.calls("launchctl").filter((c) => c[0] === "bootstrap").length).toBe(boots)

  // nothing routes to the pool until a workspace opts in
  expect(url(path.join(work, ".inscope"))).toBe(`http://127.0.0.1:${p1}`)
  const add = s.cli(["add", work, "--pool", "work", "-y"])
  expect(add.status).toBe(0)
  expect(add.stdout).toContain("goes through the proxy, on pool work")
  expect(url(path.join(work, ".inscope"))).toBe(`http://127.0.0.1:${p2}`)
  expect(url(path.join(iso, ".inscope"))).toBe(`http://127.0.0.1:${p1}`)
  expect(url(base)).toBe(`http://127.0.0.1:${p1}`)

  // status, list, and pool list name the pool
  expect(s.cli(["status"], {}, work).stdout).toContain(
    `isolated · pool work · proxy 127.0.0.1:${p2} · 2 accounts`,
  )
  expect(s.cli(["list"]).stdout).toContain(".inscope (isolated config, pool work)")
  expect(JSON.parse(s.cli(["pool", "list", "--json"]).stdout)).toEqual([
    {
      pool: "default",
      url: `http://127.0.0.1:${p1}`,
      accounts: ["me@x.dev"],
      usedBy: ["the shared login", "iso"],
    },
    {
      pool: "work",
      url: `http://127.0.0.1:${p2}`,
      accounts: ["w1@x.dev", "w2@x.dev"],
      usedBy: ["work"],
    },
  ])
  // doctor checks each pool
  const checks = JSON.parse(s.cli(["doctor", "--json"]).stdout).checks
  expect(checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      label: "proxy work",
      detail: expect.stringContaining("2 account(s)"),
    }),
  )
  expect(checks).toContainEqual({
    status: "ok",
    label: "[work] claude",
    detail: "isolated in ~/work/.inscope, through the proxy (pool work)",
  })

  // --pool default puts it back; turning isolation off drops the pool with a note
  expect(s.cli(["add", work, "--pool", "default", "-y"]).status).toBe(0)
  expect(url(path.join(work, ".inscope"))).toBe(`http://127.0.0.1:${p1}`)
  expect(s.cli(["add", work, "--pool", "work", "-y"]).status).toBe(0)
  const off = s.cli(["add", work, "--no-isolate", "-y"])
  expect(off.status).toBe(0)
  expect(off.stdout).toContain("this workspace left pool work")
  expect(s.readCfg()?.workspaces.find((w) => w.name === "work")?.pool).toBeUndefined()
  // a pool that does not exist is refused
  const none = s.cli(["add", work, "--pool", "nope", "-y"])
  expect(none.status).toBe(1)
  expect(none.stderr).toContain("No pool nope")
}, 60_000)

test("CLI: an account lives in one pool, and a failed first sign-in leaves no pool behind", async () => {
  const { s, p1, p2, login, poolDir, agent } = poolSandbox()
  expect((await login("me@x.dev", ["--port", String(p1)])).status).toBe(0)
  const twice = await login("me@x.dev", ["--pool", "work", "--port", String(p2)])
  expect(twice.status).toBe(1)
  expect(twice.stderr).toContain(
    "me@x.dev is already in pool default, and an account lives in one pool only; removed it from work",
  )
  // the pool it would have created is gone again, with its agent
  expect(fs.existsSync(poolDir)).toBe(false)
  expect(fs.existsSync(agent("dev.inscope.proxy.work"))).toBe(false)
  expect(s.readCfg()?.pools).toBeUndefined()

  const failed = await login("w1@x.dev", ["--pool", "work", "--port", String(p2)], {
    FAKE_LOGIN_FAIL: "1",
  })
  expect(failed.status).toBe(1)
  expect(fs.existsSync(poolDir)).toBe(false)
  expect(s.readCfg()?.pools).toBeUndefined()
  // a port another pool uses is refused before anything starts
  const clash = await login("w1@x.dev", ["--pool", "work", "--port", String(p1)])
  expect(clash.status).toBe(1)
  expect(clash.stderr).toContain(`Port ${p1} is already used by another pool`)
}, 60_000)

test("CLI: logout keeps a used pool's last account, and the last of an unused pool takes the pool", async () => {
  const { s, p1, p2, work, login, poolDir, agent, loaded } = poolSandbox()
  expect((await login("me@x.dev", ["--port", String(p1)])).status).toBe(0)
  expect((await login("w1@x.dev", ["--pool", "work", "--port", String(p2)])).status).toBe(0)
  expect(s.cli(["add", work, "--pool", "work", "-y"]).status).toBe(0)

  const used = await s.cliAsync(["logout", "w1@x.dev"])
  expect(used.status).toBe(1)
  expect(used.stderr).toContain("w1@x.dev is the last account in pool work, which work uses")

  expect(s.cli(["add", work, "--pool", "default", "-y"]).status).toBe(0)
  const gone = await s.cliAsync(["logout", "w1@x.dev"])
  expect(gone.status).toBe(0)
  expect(gone.stdout).toContain("✓ removed w1@x.dev from pool work")
  expect(gone.stdout).toContain("so pool work is gone too")
  expect(s.readCfg()?.pools).toBeUndefined()
  expect(fs.existsSync(poolDir)).toBe(false)
  expect(fs.existsSync(agent("dev.inscope.proxy.work"))).toBe(false)
  expect(loaded("dev.inscope.proxy.work")).toBe(false)
}, 60_000)

test("CLI: proxy stop, start, and uninstall act on every pool", async () => {
  const { s, p1, p2, work, login, url, agent, loaded } = poolSandbox()
  expect((await login("me@x.dev", ["--port", String(p1)])).status).toBe(0)
  expect((await login("w1@x.dev", ["--pool", "work", "--port", String(p2)])).status).toBe(0)
  expect(s.cli(["add", work, "--pool", "work", "-y"]).status).toBe(0)

  expect(s.cli(["proxy", "stop"]).status).toBe(0)
  expect(loaded("dev.inscope.proxy")).toBe(false)
  expect(loaded("dev.inscope.proxy.work")).toBe(false)
  expect(s.cli(["proxy", "start"]).status).toBe(0)
  expect(loaded("dev.inscope.proxy")).toBe(true)
  expect(loaded("dev.inscope.proxy.work")).toBe(true)

  const status = JSON.parse((await s.cliAsync(["proxy", "status", "--json"])).stdout)
  expect(status.pools.map((p: any) => [p.pool, p.healthy, p.accounts.length])).toEqual([
    ["default", true, 1],
    ["work", true, 1],
  ])

  expect((await s.cliAsync(["proxy", "uninstall"])).status).toBe(0)
  expect(fs.existsSync(agent("dev.inscope.proxy"))).toBe(false)
  expect(fs.existsSync(agent("dev.inscope.proxy.work"))).toBe(false)
  const cfg = s.readCfg()!
  expect([cfg.proxy, cfg.pools, cfg.workspaces.find((w) => w.name === "work")?.pool]).toEqual([
    undefined,
    undefined,
    undefined,
  ])
  expect(url(path.join(work, ".inscope"))).toBeUndefined()
}, 60_000)

// --- the real CLIProxyAPI: two pools side by side ------------------------------------------

// Two pinned, checksum-verified instances, each with its own config, auth dir, and port,
// both in front of one stub of Anthropic's Messages API. The "personal" pool holds one
// account, the "work" pool two, each allowing two requests. Every request a pool serves
// reaches only that pool's accounts, and the work pool fails over between its own two
// accounts, never into the other pool, which keeps answering. macOS only (the pinned
// builds are darwin).
test.skipIf(process.platform !== "darwin")(
  "two real proxies keep their pools apart, and each fails over within its own accounts",
  async () => {
    const { installProxy, proxyHealthy, renderProxyConfig } = await import("@/proxy")
    const { spawn } = await import("node:child_process")
    const os = await import("node:os")
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inscope-pools-")))
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = path.join(dir, ".config")
    const msgs = await startMessagesEmulator({
      "key-me": { label: "personal", quota: 2 },
      "key-w1": { label: "work-1", quota: 2 },
      "key-w2": { label: "work-2", quota: 2 },
    })
    const procs: ReturnType<typeof spawn>[] = []
    try {
      const bin = await installProxy()
      const key = "test-client-key"
      const start = (name: string, keys: string[]) => {
        const port = 20000 + Math.floor(Math.random() * 20000)
        const home = path.join(dir, name)
        fs.mkdirSync(path.join(home, "auth"), { recursive: true })
        const cfgFile = path.join(home, "config.yaml")
        fs.writeFileSync(
          cfgFile,
          renderProxyConfig({ port, key, authDir: path.join(home, "auth") }) +
            `api-keys:
  claude:
    - name: ${name}
      base-url: ${JSON.stringify(msgs.url)}
      models:
        - name: "claude-haiku-4-5"
          alias: "claude-haiku-4-5"
      keys:
${keys.map((k) => `        - api-key: "${k}"`).join("\n")}
`,
        )
        procs.push(
          spawn(bin, ["-config", cfgFile], {
            stdio: "ignore",
            env: { ...process.env, HOME: home },
          }),
        )
        return port
      }
      const personal = start("personal", ["key-me"])
      const work = start("work", ["key-w1", "key-w2"])
      expect(await proxyHealthy(personal, key, { waitMs: 15_000 })).toBe(true)
      expect(await proxyHealthy(work, key, { waitMs: 15_000 })).toBe(true)

      const ask = async (port: number, session: string, turns: number) => {
        const history: { role: string; content: string }[] = []
        const answers: string[] = []
        for (let turn = 1; turn <= turns; turn++) {
          history.push({ role: "user", content: `turn ${turn}` })
          const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "user-agent": "claude-cli/2.1.296 (external, sdk-cli)",
              "x-claude-code-session-id": session,
            },
            body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 32, messages: history }),
          })
          if (res.status !== 200) {
            answers.push(`HTTP ${res.status}`)
            break
          }
          const text = ((await res.json()) as any).content[0].text as string
          answers.push(text)
          history.push({ role: "assistant", content: text })
        }
        return answers
      }

      // the work pool: four turns, failing over from one work account to the other
      const w = await ask(work, crypto.randomUUID(), 4)
      expect(new Set(w)).toEqual(new Set(["answered by work-1", "answered by work-2"]))
      expect(w[0]).toBe(w[1])
      expect(w[2]).toBe(w[3])
      // both work accounts are spent now; the work pool never reaches the personal one
      const spent = await ask(work, crypto.randomUUID(), 1)
      expect(spent[0]).not.toBe("answered by personal")
      // and the personal pool still answers, from its own account only
      expect(await ask(personal, crypto.randomUUID(), 2)).toEqual([
        "answered by personal",
        "answered by personal",
      ])
      const byCredential = msgs.requests().filter((r) => r.status === 200)
      expect(byCredential.filter((r) => r.label === "personal")).toHaveLength(2)
      expect(byCredential.filter((r) => r.label?.startsWith("work-"))).toHaveLength(4)
      // nothing for the personal account ever came through the work pool: its only two
      // requests are the two personal turns
      expect(msgs.requests().filter((r) => r.credential === "key-me")).toHaveLength(2)
    } finally {
      for (const p of procs) p.kill()
      await msgs.close()
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  },
  120_000,
)
