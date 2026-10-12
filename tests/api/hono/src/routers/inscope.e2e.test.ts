import { describe, expect, test } from "bun:test"
import os from "node:os"

import { ROUTES } from "../../../../inscope/pages"
import { SECRETS } from "../../../../inscope/sandbox"
import { API, enabled, WEB } from "../../../../stack"

// api/hono/src/routers/inscope.ts as Bun serves it, against the sealed sandbox tests/inscope/serve.ts starts it on: the real socket peer, CORS, the mounted /api/inscope, and next dev's /api forwarding in front of it. Its expectations are the sandbox's, so it runs only when that runner names one.
const SANDBOX = process.env.E2E_INSCOPE_SANDBOX ?? ""

// an address this machine answers on from the LAN, when it has one
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address

describe.skipIf(!enabled || !SANDBOX)("api/hono/src/routers/inscope.ts", () => {
  const get = (path: string, headers: Record<string, string> = {}, base = API) =>
    fetch(`${base}${path}`, { headers })

  test("serves every route from the sandbox, never caching", async () => {
    for (const path of ROUTES) {
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
    const { data } = await (await get("/api/inscope/status")).json()
    expect(data.workspaces.find((w: { name: string }) => w.name === "acme").github).toEqual({
      account: "demo-acme",
      token: false,
    })
  })

  test("refuses a request addressed to another host name (DNS rebinding), with no-store", async () => {
    const res = await get("/api/inscope", { host: "evil.example:4000" })
    expect(res.status).toBe(403)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await res.json()).error.code).toBe("FORBIDDEN")
  })

  test("next dev's /api forwarding never reaches these routes", async () => {
    // next dev relays /api from loopback and passes the caller's own forwarding headers along, so its rewrite skips inscope's routes and the dashboard calls the API directly
    for (const host of ["localhost:3000", "rebind.attacker.test:3000"]) {
      expect((await get("/api/inscope", { host }, WEB)).status).toBe(404)
      expect((await get("/api/inscope/status", { host }, WEB)).status).toBe(404)
    }
    // its matcher does not decode, so an encoded path still reaches the API, whose gate refuses it
    expect((await get("/api/%69nscope", {}, WEB)).status).toBe(403)
    expect((await get("/api/inscop%65/status", {}, WEB)).status).toBe(403)
    // every other API route still rides it
    expect((await get("/api/health", {}, WEB)).status).toBe(200)
  })

  test.skipIf(!lanAddress)(
    "refuses this machine's LAN address, directly and through next dev",
    async () => {
      // forging Host or the forwarding headers next dev passes along gets a LAN client nowhere, directly or through it
      for (const headers of [
        {},
        { host: "localhost:3000" },
        { host: "localhost:3000", "x-forwarded-for": "127.0.0.1" },
        { host: "localhost:3000", "x-real-ip": "127.0.0.1" },
        { host: "localhost:3000", forwarded: "for=127.0.0.1;host=localhost:3000" },
      ] as Record<string, string>[]) {
        const label = JSON.stringify(headers)
        const direct = await get("/api/inscope", headers, `http://${lanAddress}:4000`)
        expect(`${label} ${direct.status}`).toBe(`${label} 403`)
        for (const path of ["/api/inscope", "/api/%69nscope"]) {
          const relayed = await get(path, headers, `http://${lanAddress}:3000`)
          expect(`${path} ${label} ${relayed.status}`).not.toBe(`${path} ${label} 200`)
        }
      }
    },
  )

  test("refuses a cross-site browser request; the dashboard's own same-site one gets CORS", async () => {
    expect((await get("/api/inscope", { "sec-fetch-site": "cross-site" })).status).toBe(403)
    const same = await get("/api/inscope", { origin: WEB, "sec-fetch-site": "same-site" })
    expect(same.status).toBe(200)
    expect(same.headers.get("access-control-allow-origin")).toBe(WEB)
    const foreign = await get("/api/inscope", { origin: "http://evil.example" })
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("refuses a write at the gate", async () => {
    const res = await fetch(`${API}/api/inscope`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    })
    expect(res.status).toBe(403)
  })

  test("unknown and impossible workspace names", async () => {
    expect((await get("/api/inscope/workspaces/nope")).status).toBe(404)
    expect((await get("/api/inscope/workspaces/bad!name")).status).toBe(400)
  })

  test("the OpenAPI document lists the inscope routes", async () => {
    const res = await get("/api/openapi.json")
    expect(res.status).toBe(200)
    const { paths } = await res.json()
    for (const path of [
      "/api/inscope",
      "/api/inscope/diff",
      "/api/inscope/doctor",
      "/api/inscope/status",
      "/api/inscope/workspaces/{name}",
    ])
      expect(Object.keys(paths)).toContain(path)
  })

  test("no response carries a credential from the sandbox", async () => {
    for (const path of ROUTES) {
      const body = await (await get(`/api/inscope${path}`)).text()
      for (const secret of SECRETS)
        expect(`${path}: ${body.includes(secret)}`).toBe(`${path}: false`)
    }
  })
})
