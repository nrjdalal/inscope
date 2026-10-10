import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { type Config, validateConfig, type Workspace } from "@/config"
import { runDoctor } from "@/doctor"
import { inscopeDirPath } from "@/generators/isolate"
import {
  applyBypass,
  applyGateway,
  gatewayKeyHelper,
  hasGatewaySetting,
  hasStaleGatewaySetting,
  inscopeSettingsPath,
  mergeBypassSettings,
  mergeGatewaySettings,
} from "@/generators/settings"

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "inscope-gw-"))

const GW = { url: "http://127.0.0.1:8317", keychain: "ANTHROPIC_AUTH_TOKEN_ACME" }

test("validateConfig guards a workspace gateway", () => {
  const cfg = (ws: Partial<Workspace>): Config => ({
    version: 1,
    workspaces: [{ name: "acme", path: "~/acme", servers: {}, ...ws } as Workspace],
  })
  expect(() => validateConfig(cfg({ isolate: true, gateway: GW }))).not.toThrow()
  expect(() =>
    validateConfig(cfg({ isolate: true, gateway: { ...GW, url: "https://gw.example.com/v1" } })),
  ).not.toThrow()
  expect(() => validateConfig(cfg({ gateway: GW }))).toThrow(/gateway requires isolate: true/)
  expect(() =>
    validateConfig(cfg({ isolate: true, gateway: "x" as unknown as typeof GW })),
  ).toThrow(/gateway must be an object/)
  expect(() => validateConfig(cfg({ isolate: true, gateway: { ...GW, url: "" } }))).toThrow(
    /gateway is missing a url/,
  )
  expect(() =>
    validateConfig(cfg({ isolate: true, gateway: { ...GW, url: "127.0.0.1:8317" } })),
  ).toThrow(/must be http or https|not a valid URL/)
  expect(() =>
    validateConfig(cfg({ isolate: true, gateway: { ...GW, url: "file:///etc/passwd" } })),
  ).toThrow(/must be http or https/)
  expect(() => validateConfig(cfg({ isolate: true, gateway: { ...GW, keychain: "" } }))).toThrow(
    /gateway is missing a keychain service/,
  )
  expect(() =>
    validateConfig(cfg({ isolate: true, gateway: { ...GW, keychain: "K$(id)" } })),
  ).toThrow(/gateway keychain .* is invalid/)
})

test("gatewayKeyHelper reads the key by service, single-quoted, with no shell variables", () => {
  expect(gatewayKeyHelper("ANTHROPIC_AUTH_TOKEN_ACME")).toBe(
    "security find-generic-password -s 'ANTHROPIC_AUTH_TOKEN_ACME' -w",
  )
  expect(gatewayKeyHelper("it's")).toBe("security find-generic-password -s 'it'\\''s' -w")
})

test("mergeGatewaySettings sets/clears only its own keys, preserving the rest", () => {
  const helper = gatewayKeyHelper(GW.keychain)
  const set = mergeGatewaySettings(
    { model: "opus", env: { FOO: "1" }, permissions: { defaultMode: "bypassPermissions" } },
    GW,
  )
  expect(set).toEqual({
    model: "opus",
    env: { FOO: "1", ANTHROPIC_BASE_URL: GW.url },
    permissions: { defaultMode: "bypassPermissions" },
    apiKeyHelper: helper,
  })
  // idempotent
  expect(mergeGatewaySettings(set, GW)).toEqual(set)
  // a changed url/keychain overwrites inscope's keys
  expect(
    mergeGatewaySettings(set, { url: "https://gw.example.com", keychain: "OTHER" }),
  ).toMatchObject({
    env: { FOO: "1", ANTHROPIC_BASE_URL: "https://gw.example.com" },
    apiKeyHelper: gatewayKeyHelper("OTHER"),
  })
  // clearing removes the pair and keeps unrelated env
  expect(mergeGatewaySettings(set, undefined)).toEqual({
    model: "opus",
    env: { FOO: "1" },
    permissions: { defaultMode: "bypassPermissions" },
  })
  // an env object inscope emptied is dropped
  expect(mergeGatewaySettings(mergeGatewaySettings({}, GW), undefined)).toEqual({})
  // a hand-set helper (and its base URL) is left alone when clearing
  const hand = { apiKeyHelper: "~/bin/key.sh", env: { ANTHROPIC_BASE_URL: "https://mine" } }
  expect(mergeGatewaySettings(hand, undefined)).toEqual(hand)
  // composes with the bypass merge in either order
  expect(mergeBypassSettings(mergeGatewaySettings({}, GW), true)).toEqual(
    mergeGatewaySettings(mergeBypassSettings({}, true), GW),
  )
})

test("applyGateway writes an isolated login's settings.json alongside bypass, no-ops elsewhere", () => {
  const dir = tmpDir()
  const ws: Workspace = { name: "acme", path: dir, isolate: true, servers: {}, gateway: GW }
  fs.mkdirSync(inscopeDirPath(ws))
  const read = () => JSON.parse(fs.readFileSync(inscopeSettingsPath(ws), "utf8"))

  applyBypass(ws, true)
  applyGateway(ws)
  expect(read()).toEqual({
    permissions: { defaultMode: "bypassPermissions" },
    skipDangerousModePermissionPrompt: true,
    env: { ANTHROPIC_BASE_URL: GW.url },
    apiKeyHelper: gatewayKeyHelper(GW.keychain),
  })
  expect(hasGatewaySetting(ws)).toBe(true)
  expect(hasStaleGatewaySetting(ws)).toBe(false)

  // gateway removed from config: apply clears it, bypass stays
  const off: Workspace = { ...ws, gateway: undefined }
  expect(hasStaleGatewaySetting(off)).toBe(true)
  applyGateway(off)
  expect(read()).toEqual({
    permissions: { defaultMode: "bypassPermissions" },
    skipDangerousModePermissionPrompt: true,
  })
  expect(hasStaleGatewaySetting(off)).toBe(false)

  // a gateway-only file, cleared, is removed rather than left as `{}`
  const only: Workspace = { name: "o", path: tmpDir(), isolate: true, servers: {}, gateway: GW }
  fs.mkdirSync(inscopeDirPath(only))
  applyGateway(only)
  expect(fs.existsSync(inscopeSettingsPath(only))).toBe(true)
  applyGateway({ ...only, gateway: undefined })
  expect(fs.existsSync(inscopeSettingsPath(only))).toBe(false)

  // a non-isolated workspace never gets a settings.json
  const plain = { name: "p", path: tmpDir(), servers: {}, gateway: GW } as Workspace
  fs.mkdirSync(path.join(plain.path, ".inscope"))
  applyGateway(plain)
  expect(fs.existsSync(inscopeSettingsPath(plain))).toBe(false)

  // an unparseable settings.json is never clobbered
  const bad: Workspace = { name: "b", path: tmpDir(), isolate: true, servers: {}, gateway: GW }
  fs.mkdirSync(inscopeDirPath(bad))
  fs.writeFileSync(inscopeSettingsPath(bad), "{nope")
  expect(() => applyGateway(bad)).toThrow(/not valid JSON/)
  expect(fs.readFileSync(inscopeSettingsPath(bad), "utf8")).toBe("{nope")
})

test("runDoctor checks the gateway key and flags gateway drift in both directions", () => {
  const mk = () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, ".inscope"))
    fs.writeFileSync(path.join(dir, ".inscope", ".credentials.json"), "{}")
    return dir
  }
  const checks = (ws: Workspace, keyStored = true) =>
    runDoctor({ version: 1, workspaces: [ws] }, (cmd, args) =>
      cmd === "security" && args.includes(GW.keychain)
        ? { status: keyStored ? 0 : 44, stdout: keyStored ? "k" : "", stderr: "" }
        : { status: 1, stdout: "", stderr: "" },
    ).filter((c) => c.label === "[acme] gateway")

  // configured, key stored, not yet applied -> keychain ok + "not applied" warn
  const dir = mk()
  const ws: Workspace = { name: "acme", path: dir, isolate: true, servers: {}, gateway: GW }
  const before = checks(ws)
  expect(before.find((c) => c.status === "ok")?.detail).toBe(`${GW.url} · ${GW.keychain}`)
  expect(before.some((c) => c.detail?.includes("not applied to this login"))).toBe(true)

  // applied -> no drift warn
  applyGateway(ws)
  expect(checks(ws).some((c) => c.status === "warn")).toBe(false)

  // key missing -> fail with the store command
  const missing = checks(ws, false).find((c) => c.status === "fail")
  expect(missing?.detail).toContain(`-s '${GW.keychain}' -w '<gateway key>'`)

  // removed from config but still on disk -> stale warn
  const stale = checks({ ...ws, gateway: undefined })
  expect(stale.some((c) => c.detail?.includes("still routes through it"))).toBe(true)
})

// --- the real CLI: flags that take isolation away also take the gateway --------------

const ENTRY = path.join(import.meta.dir, "..", "bin", "index.ts")

const sandboxCli = () => {
  const sb = fs.realpathSync(tmpDir())
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
  const readWs = () => (JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Config).workspaces[0]
  const writeCfg = (cfg: Config) => {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n")
  }
  return { sb, cli, readWs, writeCfg }
}

test("CLI: add --no-isolate drops the gateway with a note, and apply clears it from the login", () => {
  const s = sandboxCli()
  const ws = path.join(s.sb, "acme")
  fs.mkdirSync(ws)
  s.writeCfg({
    version: 1,
    workspaces: [{ name: "acme", path: ws, isolate: true, servers: {}, gateway: GW }],
  })
  expect(s.cli(["apply"]).status).toBe(0)
  const settings = path.join(ws, ".inscope", "settings.json")
  expect(JSON.parse(fs.readFileSync(settings, "utf8")).env.ANTHROPIC_BASE_URL).toBe(GW.url)

  // re-running add without touching isolation keeps the gateway
  expect(s.cli(["add", ws, "--label", "acme", "-y"]).status).toBe(0)
  expect(s.readWs().gateway).toEqual(GW)

  const r = s.cli(["add", ws, "--label", "acme", "--no-isolate", "-y"])
  expect(r.status).toBe(0)
  expect(r.stdout).toContain(
    `Note: removed the gateway (${GW.url}); it requires an isolated login.`,
  )
  expect(s.readWs().gateway).toBeUndefined()
})

test("doctor warns when ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN would outrank the gateway key", () => {
  const dir = tmpDir()
  const ws: Workspace = { name: "acme", path: dir, isolate: true, servers: {}, gateway: GW }
  const run = (cmd: string) =>
    cmd === "security"
      ? { status: 0, stdout: "key\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "" }
  const prev = process.env.ANTHROPIC_API_KEY
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-x"
    const checks = runDoctor({ version: 1, workspaces: [ws] }, run)
    expect(checks).toContainEqual({
      status: "warn",
      label: "[acme] gateway",
      detail: "ANTHROPIC_API_KEY is set in this shell and outranks the gateway's key; unset it",
    })
    delete process.env.ANTHROPIC_API_KEY
    const clean = runDoctor({ version: 1, workspaces: [ws] }, run)
    expect(clean.some((c) => c.detail?.includes("outranks"))).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prev
  }
})
