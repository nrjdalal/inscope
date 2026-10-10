import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { configHome, home } from "@/env"
import {
  anthropicApiBase,
  type FetchLike,
  fetchPlan,
  fetchUsage,
  planLabel,
  resetsIn,
} from "@/usage"

import { startAnthropicEmulator } from "./support/anthropic-emulator"
import { sandbox } from "./support/sandbox"

// --- unit -----------------------------------------------------------------------------

test("planLabel reads the Max multiplier from the tier, else the organization type", () => {
  expect(
    planLabel({ rateLimitTier: "default_claude_max_20x", organizationType: "claude_max" }),
  ).toBe("max 20x")
  expect(planLabel({ rateLimitTier: "default_claude_max_5x" })).toBe("max 5x")
  expect(planLabel({ organizationType: "claude_pro" })).toBe("pro")
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

test("anthropicApiBase honors the override only for a loopback host", () => {
  const prev = process.env.INSCOPE_ANTHROPIC_API_URL
  try {
    for (const [v, want] of [
      ["http://127.0.0.1:4100/", "http://127.0.0.1:4100"],
      ["http://localhost:9", "http://localhost:9"],
      ["https://evil.example", "https://api.anthropic.com"],
      ["http://127.0.0.1.evil.example", "https://api.anthropic.com"],
      ["file:///etc/passwd", "https://api.anthropic.com"],
      ["not a url", "https://api.anthropic.com"],
    ]) {
      process.env.INSCOPE_ANTHROPIC_API_URL = v
      expect(anthropicApiBase()).toBe(want)
    }
  } finally {
    if (prev === undefined) delete process.env.INSCOPE_ANTHROPIC_API_URL
    else process.env.INSCOPE_ANTHROPIC_API_URL = prev
  }
})

test("configHome ignores a relative XDG_CONFIG_HOME", () => {
  const prev = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = "cfg"
    expect(configHome()).toBe(path.join(home(), ".config"))
    process.env.XDG_CONFIG_HOME = "/abs/cfg"
    expect(configHome()).toBe("/abs/cfg")
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  }
})

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

test("fetchPlan reads the plan from the profile, and never fails the row", async () => {
  expect(
    await fetchPlan(
      "t",
      fakeFetch(200, { organization: { rate_limit_tier: "default_claude_max_20x" } }),
    ),
  ).toBe("max 20x")
  expect(
    await fetchPlan("t", fakeFetch(200, { organization: { organization_type: "claude_pro" } })),
  ).toBe("pro")
  expect(await fetchPlan("t", fakeFetch(401, {}))).toBeUndefined()
  expect(await fetchPlan("t", fakeFetch(200, null))).toBeUndefined()
  expect(await fetchPlan("t", fakeFetch(0, null, new Error("ECONNREFUSED")))).toBeUndefined()
})

// --- the real CLI against the proxy's accounts and a usage emulator ----------------------

const FIVE = "2026-10-10T17:00:00Z"
const WEEK = "2026-10-14T00:00:00Z"
let emu: Awaited<ReturnType<typeof startAnthropicEmulator>>
beforeAll(async () => {
  const ok = (fiveHour: number, week: number, tier?: string) => ({
    kind: "ok" as const,
    fiveHour,
    week,
    fiveHourResets: FIVE,
    weekResets: WEEK,
    tier,
  })
  emu = await startAnthropicEmulator({
    "tok-w@x.dev": ok(37, 92, "default_claude_max_20x"),
    "tok-p@x.dev": ok(5, 10, "default_claude_max_5x"),
    "tok-r@x.dev": { kind: "status", status: 429 },
    "tok-d@x.dev": { kind: "shape", body: { unexpected: true } },
  })
})
afterAll(() => emu.close())

const writeAuth = (s: ReturnType<typeof sandbox>, email: string, extra: object = {}) => {
  const dir = path.join(s.sb, ".config", "inscope", "proxy", "auth")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `claude-${email}.json`),
    JSON.stringify({
      type: "claude",
      email,
      access_token: `tok-${email}`,
      expired: "2099-01-01T00:00:00Z",
      ...extra,
    }),
  )
}

test("CLI: usage reads each proxy account's plan and limits, and never sends an expired token", async () => {
  const s = sandbox()
  s.writeCfg({ version: 1, proxy: { port: 9999 }, workspaces: [] })
  writeAuth(s, "w@x.dev")
  writeAuth(s, "p@x.dev", { disabled: true })
  writeAuth(s, "r@x.dev")
  writeAuth(s, "d@x.dev")
  writeAuth(s, "e@x.dev", { expired: "2001-01-01T00:00:00Z" })
  writeAuth(s, "s@x.dev", { access_token: undefined })
  const seen = emu.requests().length

  const r = await s.cliAsync(["usage", "--json"], { INSCOPE_ANTHROPIC_API_URL: emu.url })
  expect(r.stderr).toBe("")
  const by = Object.fromEntries(JSON.parse(r.stdout).map((x: any) => [x.email, x]))
  expect(by["w@x.dev"]).toMatchObject({
    state: "ok",
    plan: "max 20x",
    fiveHour: { percent: 37, resetsAt: FIVE },
    weekly: { percent: 92, resetsAt: WEEK },
  })
  expect(by["p@x.dev"]).toMatchObject({ state: "ok", plan: "max 5x", disabled: true })
  expect(by["r@x.dev"]).toMatchObject({ state: "rate-limited" })
  expect(by["d@x.dev"]).toMatchObject({
    state: "error",
    detail: "usage endpoint returned no 5h or weekly window",
  })
  expect(by["e@x.dev"]).toMatchObject({ state: "expired" })
  expect(by["s@x.dev"]).toMatchObject({ state: "signed-out" })

  // the right headers, and an expired or missing token never left the machine
  const sent = emu.requests().slice(seen)
  expect(sent.every((q) => q.beta === "oauth-2025-04-20")).toBe(true)
  expect([...new Set(sent.map((q) => q.authorization))].sort()).toEqual(
    ["d@x.dev", "p@x.dev", "r@x.dev", "w@x.dev"].map((e) => `Bearer tok-${e}`),
  )

  const table = (await s.cliAsync(["usage"], { INSCOPE_ANTHROPIC_API_URL: emu.url })).stdout
  expect(table).toMatch(/ACCOUNT\s+PLAN\s+5-HOUR\s+WEEKLY/)
  expect(table).toMatch(/w@x\.dev\s+max 20x\s+37% · \S+.*\s+92% · /)
  expect(table).toContain("p@x.dev (disabled)")
  expect(table).toContain(
    "expired (e@x.dev): the proxy renews tokens on its own; if this stays, sign in again with `inscope login`",
  )
  expect(table).toContain("signed out (s@x.dev): sign in again with `inscope login`")
}, 30_000)

test("CLI: usage with no proxy points at inscope login", () => {
  const s = sandbox()
  const r = s.cli(["usage"])
  expect(r.status).toBe(0)
  expect(r.stdout).toContain("No Claude accounts yet. Sign one in with `inscope login`.")
  expect(JSON.parse(s.cli(["usage", "--json"]).stdout)).toEqual([])
})
