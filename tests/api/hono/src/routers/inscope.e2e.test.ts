import { describe, expect, test } from "bun:test"
import os from "node:os"

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

  test("refuses the same rebinding through next dev's /api forwarding", async () => {
    // next dev relays /api from loopback with the Host rewritten; the hop it came from rides in x-forwarded-host
    const res = await get("/api/inscope", { host: "rebind.attacker.test:3000" }, WEB)
    expect(res.status).toBe(403)
    // it names no client, so even a loopback caller is refused through it, and a LAN caller cannot pass by forging Host
    expect((await get("/api/inscope", {}, WEB)).status).toBe(403)
    expect((await get("/api/inscope", { host: "localhost:3000" }, WEB)).status).toBe(403)
  })

  test.skipIf(!lanAddress)(
    "refuses this machine's LAN address, directly and through next dev",
    async () => {
      expect((await get("/api/inscope", {}, `http://${lanAddress}:4000`)).status).toBe(403)
      expect((await get("/api/inscope", {}, `http://${lanAddress}:3000`)).status).toBe(403)
      // a LAN client cannot pass by forging the Host the forwarding passes along
      const forged = await get(
        "/api/inscope",
        { host: "localhost:3000" },
        `http://${lanAddress}:3000`,
      )
      expect(forged.status).toBe(403)
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
    expect((await get("/api/inscope/workspaces/bad%20name")).status).toBe(400)
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
    for (const path of [
      "",
      "/status",
      "/doctor",
      "/diff",
      "/workspaces/personal",
      "/workspaces/work",
      "/workspaces/acme",
    ]) {
      const body = await (await get(`/api/inscope${path}`)).text()
      for (const secret of SECRETS)
        expect(`${path}: ${body.includes(secret)}`).toBe(`${path}: false`)
    }
  })
})
