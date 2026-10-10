import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { type Config, validateConfig } from "@/config"
import { runDoctor } from "@/doctor"
import { closeWindow, loginProfileDir } from "@/login"
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
  PROXY_VERSION,
  routeTo,
  proxyHealthy,
  proxyRoute,
  renderProxyConfig,
  startProxy,
  uninstallProxy,
} from "@/proxy"
import type { Runner } from "@/secrets"

import { startMessagesEmulator } from "./support/anthropic-messages-emulator"
import { sandbox } from "./support/sandbox"

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

test("proxyRoute sends every login to the proxy, once one is configured", () => {
  expect(routeTo(9000)).toEqual({ url: "http://127.0.0.1:9000", keychain: PROXY_KEYCHAIN })
  expect(proxyRoute({ version: 1, proxy: { port: 9000 }, workspaces: [] })).toEqual(routeTo(9000))
  expect(proxyRoute({ version: 1, workspaces: [] })).toBeUndefined()
  expect(proxyRoute(null)).toBeUndefined()
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

      // --browser none: the URL is printed for you to open, with no Chrome wording
      fs.rmSync(flag, { force: true })
      const lines: string[] = []
      const printed = await loginProxyAccount({
        bin,
        mode: "none",
        log: (l) => {
          lines.push(l)
          if (l.includes("https://")) as("n@x.dev")("")
        },
      })
      expect(printed.email).toBe("n@x.dev")

      // signing an account in again replaces its earlier file instead of adding a second
      fs.rmSync(flag)
      writeAuth(path.join(proxyAuthDir(), "claude-old-a.json"), {
        type: "claude",
        email: "A@x.dev",
      })
      await loginProxyAccount({ bin, openUrl: as("a@x.dev"), log: () => {} })
      expect(proxyAccounts().map((a) => path.basename(a.file))).toEqual([
        "claude-a@x.dev.json",
        "claude-n@x.dev.json",
        "claude-other.json",
      ])
      expect(lines.join("\n")).toContain(
        "Open this URL in the browser you want to sign in with:\nhttps://claude.ai/oauth/authorize",
      )
      expect(lines.join("\n")).not.toContain("Chrome")

      // an opener that fails (no Chrome, say) ends the login instead of leaving it running
      const started = Date.now()
      await expect(
        loginProxyAccount({
          bin,
          log: () => {},
          openUrl: () => {
            throw new Error("no Chrome-family browser found")
          },
        }),
      ).rejects.toThrow("no Chrome-family browser found")
      expect(Date.now() - started).toBeLessThan(4000)
    } finally {
      delete process.env.FAKE_SIGNED_IN
      delete process.env.FAKE_AUTH_DIR
    }
  })
}, 20_000)

test("closeWindow waits for the browser to exit before removing its profile, and never throws", async () => {
  await inSandbox(async () => {
    const profile = loginProfileDir("proxy")
    fs.mkdirSync(profile, { recursive: true })
    // a "browser" that keeps writing into its profile for a moment after SIGTERM
    const browser = spawn(
      "sh",
      [
        "-c",
        `trap 'i=0; while [ $i -lt 300 ]; do mkdir -p "$0/late$i" && echo x > "$0/late$i/f"; i=$((i+1)); done; exit 0' TERM; while :; do sleep 0.05; done`,
        profile,
      ],
      { stdio: "ignore" },
    )
    await new Promise((r) => setTimeout(r, 200))
    fs.writeFileSync(`${profile}.pid`, String(browser.pid))
    expect(() => closeWindow("proxy")).not.toThrow()
    // still gone once the browser has had time to write anything else
    await new Promise((r) => setTimeout(r, 500))
    expect(fs.existsSync(profile)).toBe(false)
    expect(fs.existsSync(`${profile}.pid`)).toBe(false)
  })
})

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

// The real CLI in a sandbox HOME, with a stand-in proxy binary already "installed" (so
// nothing downloads), fake `launchctl` and `security` on PATH (so the live proxy's agent
// and Keychain item are never touched), and the Messages emulator answering the health
// check on the proxy's port.
const FAKE_PROXY = path.join(import.meta.dir, "support", "fake-proxy", "cli-proxy-api")
let health: Awaited<ReturnType<typeof startMessagesEmulator>>
beforeAll(async () => {
  health = await startMessagesEmulator({})
})
afterAll(() => health?.close())

const proxySandbox = () => {
  const s = sandbox()
  const bin = path.join(s.sb, ".config", "inscope", "proxy", "bin", PROXY_VERSION, "cli-proxy-api")
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.copyFileSync(FAKE_PROXY, bin)
  fs.chmodSync(bin, 0o755)
  const port = Number(new URL(health.url).port)
  const iso = path.join(s.sb, "iso")
  fs.mkdirSync(iso)
  s.writeCfg({ version: 1, workspaces: [{ isolate: true, name: "iso", path: iso, servers: {} }] })
  const login = (email: string, args: string[] = [], extra: Record<string, string> = {}) =>
    s.cliAsync(["login", "--browser", "none", "--port", String(port), ...args], {
      FAKE_LOGIN_EMAIL: email,
      ...extra,
    })
  const settings = (dir: string) => {
    const f = path.join(dir, "settings.json")
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined
  }
  const authDir = path.join(s.sb, ".config", "inscope", "proxy", "auth")
  const routed = {
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
    apiKeyHelper: "security find-generic-password -s 'INSCOPE_PROXY_KEY' -w",
  }
  return { s, port, iso, login, settings, authDir, routed, base: path.join(s.sb, ".claude") }
}

test("CLI: the first login sets the proxy up, signs the account in, and routes every login", async () => {
  const { s, port, iso, login, settings, authDir, routed, base } = proxySandbox()
  const first = await login("a@x.dev")
  expect(first.stderr).toBe("")
  expect(first.status).toBe(0)
  expect(first.stdout).toContain(
    "Open this URL in the browser you want to sign in with:\nhttps://claude.ai/oauth/authorize",
  )
  expect(first.stdout).toContain("✓ a@x.dev signed in")
  expect(first.stdout).toContain("holds 1 account; every Claude Code login goes through it")
  // set up: the port recorded, a random client key, a private config, the agent loaded
  expect(s.readCfg()?.proxy).toEqual({ port })
  expect(s.keychain().INSCOPE_PROXY_KEY).toMatch(/^inscope-[0-9a-f]{48}$/)
  const yaml = path.join(s.sb, ".config", "inscope", "proxy", "config.yaml")
  expect(fs.statSync(yaml).mode & 0o777).toBe(0o600)
  const plist = path.join(s.sb, "Library", "LaunchAgents", "dev.inscope.proxy.plist")
  expect(s.calls("launchctl")).toContainEqual(["bootstrap", `gui/${process.getuid!()}`, plist])
  // the account's tokens, owner-only
  const auth = path.join(authDir, "claude-a@x.dev.json")
  expect(fs.statSync(auth).mode & 0o777).toBe(0o600)
  // every login now goes through it: the shared base and the isolated workspace
  expect(settings(base)).toEqual(routed)
  expect(settings(path.join(iso, ".inscope"))).toEqual(routed)

  // a second account: the proxy is already up, so it is not set up again
  const boots = s.calls("launchctl").filter((c) => c[0] === "bootstrap").length
  const second = await login("b@x.dev")
  expect(second.status).toBe(0)
  expect(second.stdout).toContain("holds 2 accounts")
  expect(s.calls("launchctl").filter((c) => c[0] === "bootstrap").length).toBe(boots)

  // a different port once it runs is refused, pointing at proxy setup
  const moved = await s.cliAsync(["login", "--browser", "none", "--port", "1234"], {
    FAKE_LOGIN_EMAIL: "c@x.dev",
  })
  expect(moved.status).toBe(1)
  expect(moved.stderr).toContain("change it with `inscope proxy setup --port 1234`")
}, 30_000)

test("CLI: by default the sign-in opens a new Chrome window on a fresh profile, deleted afterwards", async () => {
  const { s, port } = proxySandbox()
  const r = await s.cliAsync(["login", "--port", String(port)], {
    FAKE_LOGIN_EMAIL: "a@x.dev",
    FAKE_WAIT_FOR_BROWSER: "1",
  })
  expect(r.status).toBe(0)
  expect(r.stdout).toContain(
    "A new Chrome window (a fresh profile, deleted afterwards) opened on Claude's sign-in page.",
  )
  expect(r.stdout.match(/Chrome window/g)).toHaveLength(1)
  const [args] = s.calls("chrome")
  const profile = path.join(s.sb, ".config", "inscope", "browser", "proxy-profile")
  // a fresh, throwaway profile, opened straight on the sign-in page, nothing pre-filled
  expect(args).toEqual([
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://claude.ai/oauth/authorize?code=true&state=fake",
  ])
  expect(fs.existsSync(profile)).toBe(false)
}, 30_000)

test("CLI: a sign-in that fails or is the wrong account saves and routes nothing", async () => {
  const { s, login, settings, authDir, base } = proxySandbox()
  const failed = await login("a@x.dev", [], { FAKE_LOGIN_FAIL: "1" })
  expect(failed.status).toBe(1)
  expect(failed.stderr).toContain("the sign-in did not complete")
  const wrong = await login("z@x.dev", ["--email", "a@x.dev"])
  expect(wrong.status).toBe(1)
  expect(wrong.stderr).toContain("signed in as z@x.dev, not a@x.dev; removed it from the proxy")
  expect(fs.readdirSync(authDir).filter((f) => f.endsWith(".json"))).toEqual([])
  // no account yet, so the proxy is not recorded and no login is pointed at it
  expect(s.readCfg()?.proxy).toBeUndefined()
  expect(settings(base)).toBeUndefined()
  // and it is not left running, nor set to start at the next login
  expect(s.calls("launchctl").at(-1)?.[0]).toBe("print")
  expect(fs.existsSync(path.join(s.sb, ".fake", "launchctl-loaded"))).toBe(false)
  expect(fs.existsSync(path.join(s.sb, "Library", "LaunchAgents", "dev.inscope.proxy.plist"))).toBe(
    false,
  )
}, 30_000)

test("CLI: a first setup that fails leaves no agent behind, and the next login succeeds", async () => {
  const { s, login } = proxySandbox()
  const plist = path.join(s.sb, "Library", "LaunchAgents", "dev.inscope.proxy.plist")
  const r = await login("a@x.dev", [], { FAKE_BOOTSTRAP_FAIL: "1" })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain("launchctl bootstrap failed")
  expect(fs.existsSync(plist)).toBe(false)
  expect(s.readCfg()?.proxy).toBeUndefined()
  expect((await login("a@x.dev")).status).toBe(0)
  expect(fs.existsSync(plist)).toBe(true)
}, 30_000)

test("CLI: proxy setup --port that fails puts the proxy back where every login points", async () => {
  const { s, port, login, settings, base } = proxySandbox()
  expect((await login("a@x.dev")).status).toBe(0)
  const yaml = path.join(s.sb, ".config", "inscope", "proxy", "config.yaml")
  const r = await s.cliAsync(["proxy", "setup", "--port", "1999"], { FAKE_BOOTSTRAP_FAIL: "once" })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain("launchctl bootstrap failed")
  // the config, every login, and the running proxy all stay on the old port
  expect(s.readCfg()?.proxy).toEqual({ port })
  expect(settings(base).env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`)
  expect(fs.readFileSync(yaml, "utf8")).toContain(`port: ${port}\n`)
  expect(fs.existsSync(path.join(s.sb, ".fake", "launchctl-loaded"))).toBe(true)
}, 30_000)

test("CLI: login refuses a login with its own key helper before setting anything up", async () => {
  const { s, login, base } = proxySandbox()
  fs.mkdirSync(base, { recursive: true })
  fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify({ apiKeyHelper: "~/bin/k.sh" }))
  const r = await login("a@x.dev")
  expect(r.status).toBe(1)
  expect(r.stderr).toContain("already sets its own apiKeyHelper; remove it to send this login")
  // refused before the proxy was installed, started, or signed in to
  expect(s.calls("launchctl")).toEqual([])
  expect(s.keychain().INSCOPE_PROXY_KEY).toBeUndefined()
  expect(s.readCfg()?.proxy).toBeUndefined()
  expect(JSON.parse(fs.readFileSync(path.join(base, "settings.json"), "utf8"))).toEqual({
    apiKeyHelper: "~/bin/k.sh",
  })
}, 30_000)

test("CLI: logout removes an account, but never the proxy's last one", async () => {
  const { s, login, authDir } = proxySandbox()
  expect((await login("a@x.dev")).status).toBe(0)
  expect((await login("b@x.dev")).status).toBe(0)
  const unknown = s.cli(["logout", "z@x.dev"])
  expect(unknown.status).toBe(1)
  expect(unknown.stderr).toContain("No account z@x.dev in the proxy. It holds: a@x.dev, b@x.dev.")
  const out = s.cli(["logout", "A@x.dev"])
  expect(out.status).toBe(0)
  expect(out.stdout).toContain("✓ removed A@x.dev from the proxy")
  const last = s.cli(["logout", "b@x.dev"])
  expect(last.status).toBe(1)
  expect(last.stderr).toContain("b@x.dev is the proxy's last account")
  expect(fs.readdirSync(authDir).filter((f) => f.endsWith(".json"))).toEqual([
    "claude-b@x.dev.json",
  ])
}, 30_000)

test("CLI: stop warns that Claude Code is cut off; uninstall sends every login straight to Anthropic", async () => {
  const { s, iso, login, settings, base } = proxySandbox()
  expect((await login("a@x.dev")).status).toBe(0)
  const stop = s.cli(["proxy", "stop"])
  expect(stop.status).toBe(0)
  expect(stop.stdout).toContain("none can reach Anthropic until `inscope proxy start`")
  expect(s.cli(["proxy", "start"]).status).toBe(0)

  const gone = s.cli(["proxy", "uninstall"])
  expect(gone.status).toBe(0)
  expect(gone.stdout).toContain("every login goes straight to Anthropic again")
  expect(s.readCfg()?.proxy).toBeUndefined()
  expect(fs.existsSync(path.join(s.sb, "Library", "LaunchAgents", "dev.inscope.proxy.plist"))).toBe(
    false,
  )
  expect(s.calls("launchctl").at(-2)?.[0]).toBe("bootout")
  // no login is left pointing at a proxy that is gone
  expect(settings(base)).toBeUndefined()
  expect(settings(path.join(iso, ".inscope"))).toBeUndefined()
  // the accounts are kept unless --purge
  expect(fs.existsSync(path.join(s.sb, ".config", "inscope", "proxy", "auth"))).toBe(true)
  // with no proxy, status reads the login's own sign-in again
  expect(s.cli(["status"]).stdout).toContain(
    "Claude  shared · not signed in; launch `claude` here and log in",
  )
}, 30_000)

test("CLI: proxy commands refuse before the first login", () => {
  const s = sandbox()
  s.writeCfg({ version: 1, workspaces: [] })
  for (const sub of ["status", "start", "stop", "setup", "uninstall"]) {
    const r = s.cli(["proxy", sub])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("The proxy is not set up. Sign an account in with `inscope login`.")
  }
})

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
