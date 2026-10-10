import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { retireLegacyFields } from "@/config"
import {
  foreignRouting,
  proxyKeyHelper,
  mergeBypassSettings,
  mergeRouting,
} from "@/generators/settings"
import { PROXY_KEYCHAIN, routeTo } from "@/proxy"

import { sandbox } from "./support/sandbox"

// Every login goes through the proxy: apply writes the proxy's URL and a Keychain key
// helper into the shared base login's settings.json and each isolated workspace's.
// Anything that reads the base login runs in a sandbox HOME through the real CLI, so
// no test ever reads or writes the real ~/.claude.

const ROUTE = routeTo(18317)
const HELPER = proxyKeyHelper(PROXY_KEYCHAIN)

// --- unit -----------------------------------------------------------------------------

test("proxyKeyHelper reads the key by service, single-quoted, with no shell variables", () => {
  expect(HELPER).toBe("security find-generic-password -s 'INSCOPE_PROXY_KEY' -w")
  expect(proxyKeyHelper("it's")).toBe("security find-generic-password -s 'it'\\''s' -w")
})

test("mergeRouting sets/clears only its own keys, preserving the rest", () => {
  const set = mergeRouting(
    { model: "opus", env: { FOO: "1" }, permissions: { defaultMode: "bypassPermissions" } },
    ROUTE,
  )
  expect(set).toEqual({
    model: "opus",
    env: { FOO: "1", ANTHROPIC_BASE_URL: ROUTE.url },
    permissions: { defaultMode: "bypassPermissions" },
    apiKeyHelper: HELPER,
  })
  // idempotent, and a moved port moves the URL
  expect(mergeRouting(set, ROUTE)).toEqual(set)
  expect(mergeRouting(set, routeTo(9000)).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9000")
  // clearing removes the pair and keeps unrelated env; an env it emptied is dropped
  expect(mergeRouting(set, undefined)).toEqual({
    model: "opus",
    env: { FOO: "1" },
    permissions: { defaultMode: "bypassPermissions" },
  })
  expect(mergeRouting(mergeRouting({}, ROUTE), undefined)).toEqual({})
  // a hand-set helper (and its base URL) is left alone when clearing
  const hand = { apiKeyHelper: "~/bin/key.sh", env: { ANTHROPIC_BASE_URL: "https://mine" } }
  expect(mergeRouting(hand, undefined)).toEqual(hand)
  // composes with the bypass merge in either order
  expect(mergeBypassSettings(mergeRouting({}, ROUTE), true)).toEqual(
    mergeRouting(mergeBypassSettings({}, true), ROUTE),
  )
})

test("foreignRouting flags a key helper or base URL that is not inscope's", () => {
  expect(foreignRouting({})).toBeNull()
  expect(foreignRouting({ model: "opus", env: { FOO: "1" } })).toBeNull()
  expect(foreignRouting(mergeRouting({}, ROUTE))).toBeNull()
  expect(foreignRouting({ apiKeyHelper: "~/bin/key.sh" })).toBe("already sets its own apiKeyHelper")
  expect(foreignRouting({ env: { ANTHROPIC_BASE_URL: "https://gw.example" } })).toBe(
    "already sets its own env.ANTHROPIC_BASE_URL",
  )
})

test("retireLegacyFields drops accounts, account, and gateway, with a note for each", () => {
  const raw: Record<string, any> = {
    version: 1,
    proxy: { port: 8317 },
    accounts: [{ name: "alt1", email: "a@x.dev" }, { name: "alt2" }],
    workspaces: [
      { name: "w", path: "/w", servers: {}, account: "alt1" },
      { name: "p", path: "/p", servers: {}, isolate: true, gateway: routeTo(8317) },
      {
        name: "g",
        path: "/g",
        servers: {},
        isolate: true,
        gateway: { url: "https://gw", keychain: "K" },
      },
      { name: "plain", path: "/x", servers: {} },
    ],
  }
  const notes = retireLegacyFields(raw)
  expect(raw.accounts).toBeUndefined()
  expect(raw.workspaces.map((w: any) => [w.account, w.gateway])).toEqual([
    [undefined, undefined],
    [undefined, undefined],
    [undefined, undefined],
    [undefined, undefined],
  ])
  expect(notes).toEqual([
    "named accounts are retired; sign each Claude account in to the proxy with `inscope login`: alt1 (a@x.dev), alt2. Their old logins stay in ~/.config/inscope/accounts until you delete them.",
    'workspace "w" ran on account "alt1"; it now uses the shared login.',
    // the proxy's own URL was redundant, so only a foreign gateway gets a note
    'workspace "g" gateway (https://gw) is dropped; every login goes through the proxy (`inscope login`).',
    "These notes stop once the config is saved (`inscope apply`).",
  ])
  expect(retireLegacyFields({ version: 1, workspaces: [] })).toEqual([])
})

// --- the real CLI, in a sandbox HOME -----------------------------------------------------

const settings = (dir: string) => {
  const f = path.join(dir, "settings.json")
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined
}

const setup = () => {
  const s = sandbox()
  const iso = path.join(s.sb, "iso")
  const plain = path.join(s.sb, "plain")
  fs.mkdirSync(iso)
  fs.mkdirSync(plain)
  const base = path.join(s.sb, ".claude")
  fs.mkdirSync(base)
  // the base login's own settings, which inscope must keep
  fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify({ model: "opus" }))
  const cfg = (proxy: boolean) => ({
    version: 1,
    ...(proxy ? { proxy: { port: 18317 } } : {}),
    workspaces: [
      { isolate: true, name: "iso", path: iso, servers: {} },
      { name: "plain", path: plain, servers: {} },
    ],
  })
  const doctor = () => JSON.parse(s.cli(["doctor", "--json"]).stdout).checks as any[]
  return { s, iso, plain, base, cfg, doctor }
}

test("CLI: apply routes the shared login and every isolated one through the proxy, and back", () => {
  const { s, iso, plain, base, cfg, doctor } = setup()
  s.writeCfg(cfg(true))
  expect(s.cli(["apply"]).status).toBe(0)
  const routed = { env: { ANTHROPIC_BASE_URL: ROUTE.url }, apiKeyHelper: HELPER }
  expect(settings(base)).toEqual({ model: "opus", ...routed })
  expect(settings(path.join(iso, ".inscope"))).toEqual(routed)
  // a non-isolated workspace runs on the base login: no settings of its own
  expect(fs.existsSync(path.join(plain, ".inscope"))).toBe(false)

  // a re-apply that changes nothing leaves the file alone (Claude Code writes it too)
  const f = path.join(base, "settings.json")
  fs.utimesSync(f, new Date(0), new Date(0))
  expect(s.cli(["apply"]).status).toBe(0)
  expect(fs.statSync(f).mtimeMs).toBe(0)

  // status and doctor see the routing
  const status = s.cli(["status"], {}, iso).stdout
  expect(status).toContain("isolated · proxy 127.0.0.1:18317 · no accounts; run `inscope login`")
  expect(doctor()).toContainEqual({
    status: "ok",
    label: "claude",
    detail: "the shared login (~/.claude) goes through the proxy",
  })
  expect(doctor()).toContainEqual({
    status: "ok",
    label: "[iso] claude",
    detail: "isolated in ~/iso/.inscope, through the proxy",
  })

  // drift: a login that lost its routing is flagged
  fs.writeFileSync(f, JSON.stringify({ model: "opus" }))
  expect(doctor()).toContainEqual({
    status: "warn",
    label: "claude",
    detail: "the shared login does not go through the proxy yet; run `inscope apply`",
  })

  // the proxy removed from config: doctor flags the stale routing, apply clears it
  expect(s.cli(["apply"]).status).toBe(0)
  s.writeCfg(cfg(false))
  expect(doctor()).toContainEqual({
    status: "warn",
    label: "[iso] claude",
    detail:
      "this isolated login still points at the proxy, which is no longer set up; run `inscope apply`",
  })
  expect(s.cli(["apply"]).status).toBe(0)
  expect(settings(base)).toEqual({ model: "opus" })
  // a routing-only file is removed rather than left as `{}`
  expect(settings(path.join(iso, ".inscope"))).toBeUndefined()
}, 30_000)

test("CLI: apply refuses a login with its own key helper, before writing anything", () => {
  const { s, base, cfg } = setup()
  fs.writeFileSync(
    path.join(base, "settings.json"),
    JSON.stringify({ apiKeyHelper: "~/bin/my-key.sh" }),
  )
  s.writeCfg(cfg(true))
  const r = s.cli(["apply"])
  expect(r.status).toBe(1)
  expect(r.stderr).toContain(
    `${path.join(base, "settings.json")} already sets its own apiKeyHelper; remove it to send this login through the proxy (left it untouched)`,
  )
  expect(settings(base)).toEqual({ apiKeyHelper: "~/bin/my-key.sh" })
  // nothing else was written either: the hook is generated after the preflight
  const hook = path.join(s.sb, ".config", "inscope", "inscope.zsh")
  expect(fs.existsSync(hook)).toBe(false)
  // and once the login is free to route, apply goes through
  fs.writeFileSync(path.join(base, "settings.json"), "{}")
  expect(s.cli(["apply"]).status).toBe(0)
  expect(fs.existsSync(hook)).toBe(true)
})

test("CLI: doctor warns once when an exported API key would outrank the proxy's", () => {
  const { s, cfg } = setup()
  s.writeCfg(cfg(true))
  s.cli(["apply"])
  const shadow = (extra: Record<string, string>) =>
    JSON.parse(s.cli(["doctor", "--json"], extra).stdout).checks.filter((c: any) =>
      c.detail?.includes("outrank"),
    )
  expect(shadow({ ANTHROPIC_API_KEY: "sk-ant-api03-x" })).toEqual([
    {
      status: "warn",
      label: "proxy",
      detail: "ANTHROPIC_API_KEY is set in this shell and outranks the proxy's key; unset it",
    },
  ])
  expect(shadow({ ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "y" })).toEqual([
    {
      status: "warn",
      label: "proxy",
      detail:
        "ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are set in this shell and outrank the proxy's key; unset them",
    },
  ])
  expect(shadow({})).toEqual([])
})

test("CLI: a config with retired fields loads with a note, and apply saves it clean", () => {
  const { s, cfg } = setup()
  const legacy = cfg(true) as any
  legacy.accounts = [{ name: "alt1", email: "a@x.dev" }]
  legacy.workspaces[1].account = "alt1"
  s.writeCfg(legacy)
  const list = s.cli(["list"])
  expect(list.status).toBe(0)
  expect(list.stderr).toContain("inscope: named accounts are retired")
  expect(list.stderr).toContain('inscope: workspace "plain" ran on account "alt1"')
  expect(s.cli(["apply"]).status).toBe(0)
  const saved = s.readCfg() as any
  expect(saved.accounts).toBeUndefined()
  expect(saved.workspaces[1].account).toBeUndefined()
  expect(s.cli(["list"]).stderr).toBe("")
})
