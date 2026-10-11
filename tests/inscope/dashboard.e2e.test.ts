// The dashboard over real HTTP, against the stack tests/inscope/stack.ts starts on a sealed sandbox: the API as Bun serves it (socket peer, CORS, the mounted /api/inscope), and the pages as `next dev` serves them. Skipped unless that runner names the stack.
import { describe, expect, test } from "bun:test"

import { SECRETS } from "./sandbox"

const API = process.env.E2E_INSCOPE_API_URL ?? ""
const WEB = process.env.E2E_INSCOPE_WEB_URL ?? ""
const SANDBOX = process.env.E2E_INSCOPE_SANDBOX ?? ""

describe.skipIf(!API || !WEB)("the inscope dashboard, end to end", () => {
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${API}${path}`, { headers })

  test("the API serves every route from the sandbox, never caching", async () => {
    for (const path of ["", "/status", "/doctor", "/diff", "/workspaces/work"]) {
      const res = await get(`/api/inscope${path}`)
      expect(`${path} ${res.status}`).toBe(`${path} 200`)
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
    const { data } = await (await get("/api/inscope")).json()
    expect(data.workspaces.map((w: { name: string }) => w.name)).toEqual([
      "personal",
      "work",
      "acme",
    ])
    expect(data.workspaces[1].skills.own[1].source).toBe(`${SANDBOX}/skills/readme-audit`)
  })

  test("the real socket peer is loopback, so the gate admits this machine", async () => {
    const res = await get("/api/inscope/status")
    const { data } = await res.json()
    expect(data.workspaces.find((w: { name: string }) => w.name === "acme").github).toEqual({
      account: "demo-acme",
      token: false,
    })
  })

  test("a request addressed to another host name is refused (DNS rebinding)", async () => {
    const res = await get("/api/inscope", { host: "evil.example:4000" })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("FORBIDDEN")
  })

  test("a cross-site browser request is refused, the dashboard's own same-site one is not", async () => {
    expect((await get("/api/inscope", { "sec-fetch-site": "cross-site" })).status).toBe(403)
    const same = await get("/api/inscope", { origin: WEB, "sec-fetch-site": "same-site" })
    expect(same.status).toBe(200)
    expect(same.headers.get("access-control-allow-origin")).toBe(WEB)
  })

  test("CORS shares a response only with the trusted web origin", async () => {
    const foreign = await get("/api/inscope", { origin: "http://evil.example" })
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("a write is refused at the gate", async () => {
    const res = await fetch(`${API}/api/inscope`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    })
    expect(res.status).toBe(403)
  })

  test("unknown and impossible workspace names", async () => {
    expect((await get("/api/inscope/workspaces/nope")).status).toBe(404)
    expect((await get("/api/inscope/workspaces/bad%20name")).status).toBe(400)
  })

  test("the OpenAPI document lists the inscope routes", async () => {
    const res = await get("/api/openapi.json")
    if (res.status === 404) return // apiDocs is off in this fork's site config
    const { paths } = await res.json()
    for (const path of [
      "/api/inscope",
      "/api/inscope/status",
      "/api/inscope/doctor",
      "/api/inscope/diff",
    ])
      expect(Object.keys(paths)).toContain(path)
  })

  test("no response or page carries a credential from the sandbox", async () => {
    const bodies = await Promise.all([
      ...[
        "",
        "/status",
        "/doctor",
        "/diff",
        "/workspaces/personal",
        "/workspaces/work",
        "/workspaces/acme",
      ].map(async (path) => (await get(`/api/inscope${path}`)).text()),
      ...[
        "/inscope",
        "/inscope/skills",
        "/inscope/doctor",
        "/inscope/diff",
        "/inscope/workspaces/work",
      ].map(async (path) => (await fetch(`${WEB}${path}`)).text()),
    ])
    for (const body of bodies)
      for (const secret of SECRETS) expect(body.includes(secret)).toBe(false)
  })

  test("the pages render inside the dashboard shell, with no marketing navbar", async () => {
    for (const path of [
      "/inscope",
      "/inscope/skills",
      "/inscope/doctor",
      "/inscope/diff",
      "/inscope/workspaces/work",
    ]) {
      const res = await fetch(`${WEB}${path}`)
      expect(`${path} ${res.status}`).toBe(`${path} 200`)
      const html = await res.text()
      for (const label of ["Workspaces", "Skills", "Doctor", "Pending changes", "Local"])
        expect(html).toContain(label)
      expect(html).toContain('data-sidebar="sidebar"')
    }
  })

  test("an unknown dashboard path answers 404 inside the shell", async () => {
    const res = await fetch(`${WEB}/inscope/no/such/page`)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain("Back to workspaces")
  })
})
