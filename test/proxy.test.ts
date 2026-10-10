import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { type Config, validateConfig } from "@/config"
import { runDoctor } from "@/doctor"
import {
  ensureProxyKey,
  installProxy,
  loginProxyAccount,
  logoutProxyAccount,
  PROXY_KEYCHAIN,
  proxyAccounts,
  proxyAuthDir,
  proxyBinPath,
  proxyConfigPath,
  onProxy,
  proxyAfterLoginChange,
  proxyGateway,
  proxyHealthy,
  proxyUsers,
  renderProxyConfig,
  startProxy,
  uninstallProxy,
} from "@/proxy"
import type { Runner } from "@/secrets"

import { startAnthropicEmulator } from "./support/anthropic-emulator"
import { startMessagesEmulator } from "./support/anthropic-messages-emulator"

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inscope-proxy-")))

// Run `fn` with XDG_CONFIG_HOME (and so every proxy path) inside a fresh temp dir.
const inSandbox = async <T>(fn: (dir: string) => T | Promise<T>): Promise<T> => {
  const dir = tmp()
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config")
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  }
}

const runner =
  (impl: (cmd: string, args: string[]) => { status: number; stdout?: string }): Runner =>
  (cmd, args) => {
    const r = impl(cmd, args)
    return { status: r.status, stdout: r.stdout ?? "", stderr: "" }
  }

// --- config ---------------------------------------------------------------------------

test("validateConfig accepts a proxy port and rejects a bad one", () => {
  const base: Config = { version: 1, workspaces: [] }
  expect(() => validateConfig({ ...base, proxy: { port: 8317 } })).not.toThrow()
  for (const port of [80, 70000, 8317.5, "8317" as never])
    expect(() => validateConfig({ ...base, proxy: { port } })).toThrow(
      "config proxy.port must be an integer between 1024 and 65535",
    )
})

test("the rendered config is loopback only, keyed, management off, and fails over", () => {
  const yaml = renderProxyConfig({ port: 9000, key: "k", authDir: "/a" })
  expect(yaml).toContain('host: "127.0.0.1"')
  expect(yaml).toContain('    - "k"')
  expect(yaml).toContain('secret-key: ""')
  expect(yaml).toContain("disable-control-panel: true")
  expect(yaml).toContain("session-affinity: true")
  expect(yaml).toContain('strategy: "fill-first"')
  expect(yaml).toContain("max-retry-interval: 0")
  expect(yaml).toContain("request-log: false")
  expect(yaml).toContain('- name: "claude-haiku-4-5-20251001"\n        alias: "claude-haiku-4-5"')
})

test("proxyGateway and proxyUsers tie workspaces to the proxy by its URL", () => {
  const gw = proxyGateway(9000)
  expect(gw).toEqual({ url: "http://127.0.0.1:9000", keychain: PROXY_KEYCHAIN })
  const cfg: Config = {
    version: 1,
    proxy: { port: 9000 },
    workspaces: [
      { name: "a", path: "/a", isolate: true, servers: {}, gateway: gw },
      {
        name: "b",
        path: "/b",
        isolate: true,
        servers: {},
        gateway: { url: "http://x", keychain: "K" },
      },
      { name: "c", path: "/c", servers: {} },
    ],
  }
  expect(proxyUsers(cfg)).toEqual(["a"])
  expect(proxyUsers({ ...cfg, proxy: undefined })).toEqual([])
  expect(onProxy(cfg, cfg.workspaces[0])).toBe(true)
  expect(onProxy(cfg, cfg.workspaces[1])).toBe(false)

  // add --proxy / --no-proxy, and otherwise the gateway follows the isolated login
  const [a, b, c] = cfg.workspaces
  expect(proxyAfterLoginChange(cfg, c, true, true)).toEqual({ gateway: gw })
  expect(proxyAfterLoginChange(cfg, a, true, false)).toEqual({
    gateway: undefined,
    note: "Note: this workspace no longer goes through the proxy.",
  })
  expect(proxyAfterLoginChange(cfg, b, true, false)).toEqual({ gateway: b.gateway })
  expect(proxyAfterLoginChange(cfg, a, true, undefined)).toEqual({ gateway: gw })
  expect(proxyAfterLoginChange(cfg, a, false, undefined).gateway).toBeUndefined()
})

test("uninstallProxy removes the agent and binary, and with purge the accounts and key", async () => {
  await inSandbox(async (dir) => {
    const prevHome = process.env.HOME
    process.env.HOME = dir
    try {
      const calls: string[][] = []
      const run = runner((cmd, args) => {
        calls.push([cmd, ...args])
        return { status: cmd === "launchctl" && args[0] === "print" ? 113 : 0 }
      })
      const agent = path.join(dir, "Library", "LaunchAgents", "dev.inscope.proxy.plist")
      const seed = () => {
        for (const f of [proxyBinPath(), agent, path.join(proxyAuthDir(), "claude-a.json")]) {
          fs.mkdirSync(path.dirname(f), { recursive: true })
          fs.writeFileSync(f, "")
        }
      }
      seed()
      uninstallProxy({ run })
      expect(fs.existsSync(agent)).toBe(false)
      expect(fs.existsSync(proxyBinPath())).toBe(false)
      expect(fs.existsSync(path.join(proxyAuthDir(), "claude-a.json"))).toBe(true)
      expect(calls.some((c) => c[1] === "delete-generic-password")).toBe(false)

      seed()
      uninstallProxy({ run, purge: true })
      expect(fs.existsSync(proxyAuthDir())).toBe(false)
      expect(calls).toContainEqual(["security", "delete-generic-password", "-s", PROXY_KEYCHAIN])
    } finally {
      process.env.HOME = prevHome
    }
  })
})

// --- install --------------------------------------------------------------------------

const fakeTarball = (dir: string) => {
  const src = path.join(dir, "src")
  fs.mkdirSync(src)
  fs.writeFileSync(path.join(src, "cli-proxy-api"), "#!/bin/sh\necho fake\n", { mode: 0o755 })
  const tgz = path.join(dir, "fake.tar.gz")
  spawnSync("tar", ["-czf", tgz, "-C", src, "cli-proxy-api"])
  const bytes = new Uint8Array(fs.readFileSync(tgz))
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
}

test("installProxy verifies the pinned checksum before unpacking, and refuses a mismatch", async () => {
  await inSandbox(async (dir) => {
    const { bytes, sha256 } = fakeTarball(dir)
    const urls: string[] = []
    const fetchBytes = async (url: string) => {
      urls.push(url)
      return { status: 200, bytes }
    }
    await expect(
      installProxy({ fetchBytes, asset: { file: "x.tar.gz", sha256: "0".repeat(64) } }),
    ).rejects.toThrow("does not match its pinned checksum")
    expect(fs.existsSync(proxyBinPath())).toBe(false)

    const bin = await installProxy({ fetchBytes, asset: { file: "x.tar.gz", sha256 } })
    expect(bin).toBe(proxyBinPath())
    expect(fs.statSync(bin).mode & 0o777).toBe(0o755)
    expect(urls.at(-1)).toMatch(
      /^https:\/\/github\.com\/router-for-me\/CLIProxyAPI\/releases\/download\/v[\d.]+\/x\.tar\.gz$/,
    )
    // a failed unpack leaves nothing behind for the next run to trust
    fs.rmSync(path.dirname(bin), { recursive: true })
    const failTar = runner(() => ({ status: 1 }))
    await expect(
      installProxy({ fetchBytes, run: failTar, asset: { file: "x.tar.gz", sha256 } }),
    ).rejects.toThrow("unpacking x.tar.gz failed")
    expect(fs.readdirSync(path.dirname(path.dirname(bin)))).toEqual([])
    await installProxy({ fetchBytes, asset: { file: "x.tar.gz", sha256 } })
    expect(fs.existsSync(bin)).toBe(true)
    // installed: a second call does not download again
    await installProxy({ fetchBytes: async () => ({ status: 500, bytes: new Uint8Array() }) })
    await expect(
      installProxy({
        version: "0.0.1",
        fetchBytes: async () => ({ status: 404, bytes: new Uint8Array() }),
        asset: { file: "y", sha256 },
      }),
    ).rejects.toThrow("downloading y failed (HTTP 404)")
  })
})

test("ensureProxyKey keeps the Keychain key, or creates and stores a random one", () => {
  const added: string[][] = []
  const has = runner((cmd, args) =>
    cmd === "security" && args[0] === "find-generic-password"
      ? { status: 0, stdout: "kept\n" }
      : { status: 1 },
  )
  expect(ensureProxyKey(has)).toBe("kept")
  const none = runner((cmd, args) => {
    if (args[0] === "add-generic-password") {
      added.push(args)
      return { status: 0 }
    }
    return { status: 44 }
  })
  const key = ensureProxyKey(none)
  expect(key).toMatch(/^inscope-[0-9a-f]{48}$/)
  expect(added[0]).toContain(PROXY_KEYCHAIN)
  expect(added[0]).toContain(key)
})

test("startProxy waits for launchd to unload the old agent before bootstrapping again", () => {
  const calls: string[] = []
  let printsLeft = 3
  const run = runner((cmd, args) => {
    calls.push(args[0])
    if (args[0] === "print") return { status: printsLeft-- > 0 ? 0 : 113 }
    return { status: 0 }
  })
  startProxy(run)
  expect(calls).toEqual(["bootout", "print", "print", "print", "print", "bootstrap"])

  const failing = runner((cmd, args) => ({ status: args[0] === "bootstrap" ? 5 : 113 }))
  expect(() => startProxy(failing)).toThrow("launchctl bootstrap failed: exit 5")
})

// --- accounts and login ----------------------------------------------------------------

const writeAuth = (file: string, doc: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc))
}

test("proxyAccounts reads the proxy's Claude auth files and skips everything else", async () => {
  await inSandbox(() => {
    const dir = proxyAuthDir()
    writeAuth(path.join(dir, "claude-a@x.dev.json"), {
      type: "claude",
      email: "a@x.dev",
      access_token: "tok-a",
      expired: "2099-01-01T00:00:00Z",
    })
    writeAuth(path.join(dir, "claude-b@x.dev.json"), {
      type: "claude",
      email: "b@x.dev",
      disabled: true,
    })
    writeAuth(path.join(dir, "codex-c.json"), { type: "codex", email: "c@x.dev" })
    fs.writeFileSync(path.join(dir, "broken.json"), "{")
    const accs = proxyAccounts()
    expect(accs.map((a) => [a.email, a.accessToken, a.disabled])).toEqual([
      ["a@x.dev", "tok-a", false],
      ["b@x.dev", undefined, true],
    ])
    expect(accs[0].expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"))
    expect(logoutProxyAccount("A@X.dev")).toBe(true)
    expect(proxyAccounts().map((a) => a.email)).toEqual(["b@x.dev"])
    expect(logoutProxyAccount("nobody@x.dev")).toBe(false)
  })
})

// A stand-in for `cli-proxy-api -claude-login -no-browser`: prints the sign-in URL like
// the real one, waits for the (fake) person to finish signing in, then writes the auth
// file the way the proxy does and exits.
const fakeLoginBin = (dir: string) => {
  const bin = path.join(dir, "fake-cpa")
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "Visit the following URL to continue authentication:"
echo "https://claude.ai/oauth/authorize?code=true&state=s"
echo "Waiting for Claude authentication callback..."
i=0
while [ ! -f "$FAKE_SIGNED_IN" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
[ -f "$FAKE_SIGNED_IN" ] || exit 1
email=$(cat "$FAKE_SIGNED_IN")
# the running proxy refreshing another account's token meanwhile rewrites its file
[ -f "$FAKE_AUTH_DIR/claude-other.json" ] && touch "$FAKE_AUTH_DIR/claude-other.json"
printf '{"type":"claude","email":"%s","access_token":"tok","expired":"2099-01-01T00:00:00Z"}' "$email" > "$FAKE_AUTH_DIR/claude-$email.json"
echo "Authentication saved to $FAKE_AUTH_DIR/claude-$email.json"
echo "Claude authentication successful!"
`,
    { mode: 0o755 },
  )
  return bin
}

test("loginProxyAccount opens the printed URL, waits for the sign-in, and verifies the email", async () => {
  await inSandbox(async (dir) => {
    const bin = fakeLoginBin(dir)
    const flag = path.join(dir, "signed-in")
    process.env.FAKE_SIGNED_IN = flag
    process.env.FAKE_AUTH_DIR = proxyAuthDir()
    fs.mkdirSync(proxyAuthDir(), { recursive: true })
    try {
      const opened: string[] = []
      // atomically: the fake polls for the flag and must not read it half-written
      const as = (email: string) => (url: string) => {
        opened.push(url)
        fs.writeFileSync(`${flag}.tmp`, email)
        fs.renameSync(`${flag}.tmp`, flag)
      }
      // an account already in the proxy, whose file sorts after the new ones and is
      // rewritten during each sign-in: it must never be mistaken for the new account
      writeAuth(path.join(proxyAuthDir(), "claude-other.json"), {
        type: "claude",
        email: "other@x.dev",
      })
      const acc = await loginProxyAccount({ bin, openUrl: as("a@x.dev"), log: () => {} })
      expect(acc.email).toBe("a@x.dev")
      expect(fs.statSync(acc.file).mode & 0o777).toBe(0o600)
      expect(opened).toEqual(["https://claude.ai/oauth/authorize?code=true&state=s"])

      fs.rmSync(flag)
      await expect(
        loginProxyAccount({ bin, email: "b@x.dev", openUrl: as("z@x.dev"), log: () => {} }),
      ).rejects.toThrow("signed in as z@x.dev, not b@x.dev; removed it from the proxy")
      expect(proxyAccounts().map((a) => a.email)).toEqual(["a@x.dev", "other@x.dev"])

      fs.rmSync(flag)
      await expect(loginProxyAccount({ bin, openUrl: () => {}, log: () => {} })).rejects.toThrow(
        "the sign-in did not complete",
      )
    } finally {
      delete process.env.FAKE_SIGNED_IN
      delete process.env.FAKE_AUTH_DIR
    }
  })
}, 20_000)

// --- doctor ----------------------------------------------------------------------------

test("doctor checks the proxy's install, key, config privacy, process, and accounts", async () => {
  await inSandbox(async () => {
    const cfg: Config = { version: 1, proxy: { port: 9000 }, workspaces: [] }
    const run = (loaded: boolean) =>
      runner((cmd) =>
        cmd === "security" ? { status: 0, stdout: "k\n" } : { status: loaded ? 0 : 1 },
      )
    const proxyLines = (r: Runner) => runDoctor(cfg, r).filter((c) => c.label === "proxy")
    const missing = proxyLines(run(false)).map((c) => c.detail)
    expect(missing.some((d) => d?.includes("is not installed"))).toBe(true)
    expect(missing.some((d) => d?.includes("not running on http://127.0.0.1:9000"))).toBe(true)
    expect(missing.some((d) => d?.includes("no accounts signed in"))).toBe(true)

    fs.mkdirSync(path.dirname(proxyBinPath()), { recursive: true })
    fs.writeFileSync(proxyBinPath(), "")
    fs.mkdirSync(path.dirname(proxyConfigPath()), { recursive: true })
    fs.writeFileSync(proxyConfigPath(), "", { mode: 0o644 })
    expect(proxyLines(run(true)).map((c) => c.detail)).toContainEqual(
      expect.stringContaining("is readable by others"),
    )
    fs.chmodSync(proxyConfigPath(), 0o600)
    writeAuth(path.join(proxyAuthDir(), "claude-a.json"), { type: "claude", email: "a@x.dev" })
    fs.chmodSync(proxyAuthDir(), 0o755)
    expect(proxyLines(run(true)).map((c) => c.detail)).toContainEqual(
      expect.stringContaining("holds account tokens"),
    )
    fs.chmodSync(proxyAuthDir(), 0o700)
    expect(proxyLines(run(true))).toEqual([
      {
        status: "ok",
        label: "proxy",
        detail: expect.stringContaining("http://127.0.0.1:9000 · CLIProxyAPI"),
      },
    ])
  })
})

// --- the CLI ---------------------------------------------------------------------------

const ENTRY = path.join(import.meta.dir, "..", "bin", "index.ts")

const cliSandbox = () => {
  const sb = tmp()
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sb,
    XDG_CONFIG_HOME: path.join(sb, ".config"),
    GH_CONFIG_DIR: path.join(sb, ".gh"),
  }
  for (const k of [
    "CLAUDE_CONFIG_DIR",
    "INSCOPE_CCD",
    "INSCOPE_BASE_CCD",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ])
    delete env[k]
  const cfgFile = path.join(sb, ".config", "inscope", "inscope.json")
  const cli = (args: string[]) =>
    spawnSync("bun", [ENTRY, ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv })
  const writeCfg = (cfg: Config) => {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n")
  }
  const ws = () => (JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Config).workspaces[0]
  return { sb, cli, writeCfg, ws }
}

test("CLI: add --proxy routes a workspace through the proxy, and --no-proxy takes it off", () => {
  const s = cliSandbox()
  const dir = path.join(s.sb, "acme")
  fs.mkdirSync(dir)
  const noProxy = s.cli(["add", dir, "--proxy", "-y"])
  expect(noProxy.status).toBe(1)
  expect(noProxy.stderr).toContain("The proxy is not set up. Run `inscope proxy setup` first.")

  s.writeCfg({ version: 1, proxy: { port: 9000 }, accounts: [{ name: "work" }], workspaces: [] })
  const on = s.cli(["add", dir, "--proxy", "-y"])
  expect(on.status).toBe(0)
  expect(on.stdout).toContain(
    "its requests go through the proxy, so there is nothing to sign in to",
  )
  expect(s.ws()).toMatchObject({ isolate: true, gateway: proxyGateway(9000) })
  const settings = JSON.parse(fs.readFileSync(path.join(dir, ".inscope", "settings.json"), "utf8"))
  expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9000")

  const both = s.cli(["add", dir, "--proxy", "--account", "work", "-y"])
  expect(both.status).toBe(1)
  expect(both.stderr).toContain("--proxy and --account each pick the login")

  const off = s.cli(["add", dir, "--no-proxy", "-y"])
  expect(off.status).toBe(0)
  expect(off.stdout).toContain("this workspace no longer goes through the proxy")
  expect(s.ws().gateway).toBeUndefined()
  expect(s.ws().isolate).toBe(true)
})

test("CLI: proxy commands refuse before setup", () => {
  const s = cliSandbox()
  s.writeCfg({ version: 1, workspaces: [] })
  for (const sub of ["login", "status", "start", "stop", "uninstall"]) {
    const r = s.cli(["proxy", sub])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("The proxy is not set up")
  }
})

// --- usage: the proxy's accounts, read from its auth files ------------------------------

let usageEmu: Awaited<ReturnType<typeof startAnthropicEmulator>>
beforeAll(async () => {
  usageEmu = await startAnthropicEmulator({
    "tok-pa": {
      kind: "ok",
      fiveHour: 12,
      week: 40,
      fiveHourResets: "2099-01-01T00:00:00Z",
      weekResets: "2099-01-01T00:00:00Z",
    },
  })
})
afterAll(() => usageEmu?.close())

test("CLI: usage lists the proxy's accounts with their limits", async () => {
  const s = cliSandbox()
  s.writeCfg({
    version: 1,
    proxy: { port: 9000 },
    workspaces: [
      {
        name: "acme",
        path: path.join(s.sb, "acme"),
        isolate: true,
        servers: {},
        gateway: proxyGateway(9000),
      },
    ],
  })
  // Claude Code has run in the workspace (its .inscope is no longer empty), but the
  // workspace has no login of its own to list: its requests go through the proxy.
  writeAuth(path.join(s.sb, "acme", ".inscope", ".claude.json"), {})
  const auth = path.join(s.sb, ".config", "inscope", "proxy", "auth")
  writeAuth(path.join(auth, "claude-pa.json"), {
    type: "claude",
    email: "pa@x.dev",
    access_token: "tok-pa",
    expired: "2099-01-01T00:00:00Z",
  })
  const r = await new Promise<string>((resolve) => {
    const env = {
      ...process.env,
      HOME: s.sb,
      XDG_CONFIG_HOME: path.join(s.sb, ".config"),
      INSCOPE_ANTHROPIC_API_URL: usageEmu.url,
    } as NodeJS.ProcessEnv
    delete env.CLAUDE_CONFIG_DIR
    const child = spawn("bun", [ENTRY, "usage", "--json"], { env })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.on("close", () => resolve(out))
  })
  const rows = JSON.parse(r)
  expect(rows.find((x: any) => x.kind === "proxy")).toMatchObject({
    login: "proxy",
    email: "pa@x.dev",
    state: "ok",
    weekly: { percent: 40 },
    usedBy: ["acme"],
  })
  expect(rows.filter((x: any) => x.kind === "isolated")).toEqual([])
}, 30_000)

// --- the real CLIProxyAPI, failing over between accounts ---------------------------------

// Runs the pinned, checksum-verified release against a stub of Anthropic's Messages API
// in which every account allows two requests. A conversation (one Claude Code session
// id, growing message history) must survive its account running out: the request that
// gets a 429 is retried on the next account, and the conversation stays there. macOS
// only (the pinned builds are darwin); downloads the release once per run.
test.skipIf(process.platform !== "darwin")(
  "the real proxy keeps a conversation going when its account hits the limit",
  async () => {
    await inSandbox(async (dir) => {
      const bin = await installProxy()
      const msgs = await startMessagesEmulator({
        "key-a": { label: "acct-a", quota: 2 },
        "key-b": { label: "acct-b", quota: 2 },
      })
      const port = 20000 + Math.floor(Math.random() * 20000)
      const key = "test-client-key"
      const stub = `api-keys:
  claude:
    - name: stub
      base-url: ${JSON.stringify(msgs.url)}
      models:
        - name: "claude-haiku-4-5"
          alias: "claude-haiku-4-5"
      keys:
        - api-key: "key-a"
        - api-key: "key-b"
`
      const cfgFile = path.join(dir, "config.yaml")
      fs.mkdirSync(path.join(dir, "auth"))
      fs.writeFileSync(
        cfgFile,
        renderProxyConfig({ port, key, authDir: path.join(dir, "auth") }) + stub,
      )
      const proc = spawn(bin, ["-config", cfgFile], { stdio: "ignore" })
      try {
        expect(await proxyHealthy(port, key, { waitMs: 15_000 })).toBe(true)
        const session = crypto.randomUUID()
        const history: { role: string; content: string }[] = []
        const answers: string[] = []
        for (let turn = 1; turn <= 4; turn++) {
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
          expect(res.status).toBe(200)
          const text = ((await res.json()) as any).content[0].text as string
          answers.push(text)
          history.push({ role: "assistant", content: text })
        }
        // two turns on the first account, then the same conversation on the other
        expect(answers[0]).toBe(answers[1])
        expect(answers[2]).toBe(answers[3])
        expect(answers[2]).not.toBe(answers[0])
        const seen = msgs.requests()
        expect(seen.filter((r) => r.status === 429)).toHaveLength(1)
        expect(seen.filter((r) => r.status === 200).map((r) => r.turns)).toEqual([1, 3, 5, 7])
      } finally {
        proc.kill()
        await msgs.close()
      }
    })
  },
  120_000,
)
