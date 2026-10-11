import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import {
  isLoopbackAddress,
  isLoopbackHost,
} from "../../../../../api/hono/src/middlewares/local-only"
import { createInscopeRouter } from "../../../../../api/hono/src/routers/inscope"
import { SECRETS, type Sandbox, seedSandbox } from "../../../../inscope/sandbox"

const TRUSTED = "http://inscope.localhost:1355"

let sb: Sandbox
const saved: Record<string, string | undefined> = {}

// the library reads HOME, XDG_CONFIG_HOME and PATH at call time, so the sealed env goes on this process for the file and comes off after
beforeAll(() => {
  sb = seedSandbox()
  for (const [key, value] of Object.entries(sb.env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  for (const key of ["CLAUDE_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(sb.root, { recursive: true, force: true })
})

type Req = RequestInit & { peer?: string | null; stage?: string }

// the router as mounted, with the peer coming from a fake Bun server the way Bun passes it to fetch
const send = (
  route: string,
  { peer = "127.0.0.1", stage = "local", ...init }: Req = {},
  host = "localhost:4000",
) =>
  createInscopeRouter({ stage, trustedOrigins: [TRUSTED] }).request(
    `http://${host}${route}`,
    init,
    {
      requestIP: () => (peer === null ? null : { address: peer, family: "IPv4", port: 51234 }),
    },
  )

const data = async (route: string) => {
  const res = await send(route)
  expect(res.status).toBe(200)
  return (await res.json()).data
}

describe("the local-only gate", () => {
  test("answers loopback on localhost, portless names, and IPv6", async () => {
    expect((await send("/")).status).toBe(200)
    expect((await send("/", {}, "api.inscope.localhost:1355")).status).toBe(200)
    expect((await send("/", { peer: "::1" }, "[::1]:4000")).status).toBe(200)
    expect((await send("/", { peer: "::ffff:127.0.0.1" }, "127.0.0.1:4000")).status).toBe(200)
  })

  test("is invisible off the local stage, even from loopback", async () => {
    for (const stage of ["development", "test", "staging", "production"])
      expect((await send("/", { stage })).status).toBe(404)
  })

  test("refuses a request addressed to another host name (DNS rebinding)", async () => {
    const res = await send("/", {}, "evil.example:4000")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Only answers requests addressed to localhost" },
    })
  })

  test("refuses a peer that is not loopback, or that cannot be read", async () => {
    for (const peer of ["10.0.0.5", "192.168.1.20", "::ffff:10.0.0.5", "2001:db8::1", null])
      expect((await send("/", { peer })).status).toBe(403)
    const unreadable = createInscopeRouter({
      stage: "local",
      trustedOrigins: [],
      peer: () => {
        throw new TypeError("env has to include the 2nd argument of fetch.")
      },
    })
    expect((await unreadable.request("http://localhost:4000/")).status).toBe(403)
  })

  test("refuses a cross-site browser request and lets a same-site one through", async () => {
    expect((await send("/", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
    expect((await send("/", { headers: { "sec-fetch-site": "same-site" } })).status).toBe(200)
  })

  test("takes a write only from a trusted Origin (and no route accepts one yet)", async () => {
    expect((await send("/", { method: "POST" })).status).toBe(403)
    expect(
      (await send("/", { method: "POST", headers: { origin: "http://evil.example" } })).status,
    ).toBe(403)
    // past the gate, there is no POST route
    expect((await send("/", { method: "POST", headers: { origin: TRUSTED } })).status).toBe(404)
  })

  test("never caches a response", async () => {
    expect((await send("/")).headers.get("cache-control")).toBe("no-store")
  })

  test("isLoopbackHost and isLoopbackAddress accept only loopback", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "inscope.localhost",
      "api.inscope.localhost",
    ])
      expect(isLoopbackHost(host)).toBe(true)
    for (const host of ["localhost.evil.example", "evil.example", "0.0.0.0", "192.168.1.2"])
      expect(isLoopbackHost(host)).toBe(false)
    for (const address of ["127.0.0.1", "127.0.1.1", "::1", "::ffff:127.0.0.1"])
      expect(isLoopbackAddress(address)).toBe(true)
    for (const address of [undefined, "", "0.0.0.0", "10.0.0.1", "::ffff:10.0.0.1", "fe80::1"])
      expect(isLoopbackAddress(address)).toBe(false)
  })
})

describe("GET /api/inscope", () => {
  test("lists every workspace with its MCP file and skill links as they are on disk", async () => {
    const { config, workspaces } = await data("/")
    expect(config).toEqual({ bypass: false, exists: true, path: "~/.config/inscope/inscope.json" })
    expect(workspaces.map((w: { name: string }) => w.name)).toEqual(["personal", "work", "acme"])
    const [personal, work, acme] = workspaces
    expect(personal).toMatchObject({
      gh: "demo-personal",
      isolated: false,
      mcp: { error: null, path: "~/personal/.mcp.json", state: "in-sync" },
      servers: ["github"],
      skills: {
        dir: "~/.claude/skills",
        other: [],
        own: [{ linked: true, name: "inscope", source: null }],
      },
    })
    expect(work.isolated).toBe(true)
    expect(work.mcp.state).toBe("drifted")
    expect(work.servers).toEqual(["github", "linear", "slack"])
    expect(work.skills.own).toEqual([
      { linked: true, name: "inscope", source: null },
      { linked: true, name: "readme-audit", source: path.join(sb.root, "skills", "readme-audit") },
    ])
    expect(work.skills.other).toEqual([
      { kind: "own", label: "yours", name: "my-notes", target: null, workspace: null },
      {
        kind: "stale",
        label: "inscope link no workspace declares (the next apply removes it)",
        name: "old-notes",
        target: null,
        workspace: null,
      },
    ])
    expect(acme.mcp.state).toBe("missing")
  })
})

describe("GET /api/inscope/status", () => {
  test("resolves each workspace's Claude login, GitHub token presence, and git email", async () => {
    const { workspaces } = await data("/status")
    expect(workspaces).toEqual([
      {
        name: "personal",
        claude: {
          configDir: "~/.claude",
          email: "personal@example.com",
          isolated: false,
          org: null,
          signedIn: true,
          subscription: "max",
        },
        git: { email: "personal@example.com", source: "workspace" },
        github: { account: "demo-personal", token: true },
      },
      {
        name: "work",
        claude: {
          configDir: "~/work/.inscope",
          email: "work@example.com",
          isolated: true,
          org: "Example Co",
          signedIn: true,
          subscription: "team",
        },
        git: { email: "work@example.com", source: "workspace" },
        github: { account: "demo-work", token: true },
      },
      {
        name: "acme",
        claude: {
          configDir: "~/clients/acme/.inscope",
          email: null,
          isolated: true,
          org: null,
          signedIn: false,
          subscription: null,
        },
        git: { email: "dev@acme.example", source: "workspace" },
        github: { account: "demo-acme", token: false },
      },
    ])
  })
})

describe("GET /api/inscope/doctor", () => {
  test("runs the doctor checks and counts them", async () => {
    const { checks, summary } = await data("/doctor")
    const find = (label: string) => checks.find((c: { label: string }) => c.label === label)
    expect(find("[acme] gh")).toEqual({
      detail: "no token for demo-acme; run `gh auth login`",
      label: "[acme] gh",
      status: "fail",
    })
    expect(find("[work] gh").status).toBe("ok")
    expect(find("[acme] slack")?.status).toBe("fail")
    expect(find("[work] slack")?.status).toBe("ok")
    expect(summary.fail).toBe(checks.filter((c: { status: string }) => c.status === "fail").length)
    expect(summary.ok + summary.warn + summary.fail).toBe(checks.length)
  })
})

describe("GET /api/inscope/diff", () => {
  test("shows what apply would change, with credential values redacted and env references kept", async () => {
    const { adoptable, drifts } = await data("/diff")
    expect(adoptable).toEqual(["work: linear.url = https://mcp.linear.app/sse-old"])
    expect(drifts.map((d: { label: string }) => d.label)).toEqual([
      "mcp:work",
      "mcp:acme",
      "skills:work",
    ])
    const work = drifts[0]
    expect(work.diff).toContain('-       "url": "https://mcp.linear.app/sse-old"')
    expect(work.diff).toContain('+       "url": "https://mcp.linear.app/mcp"')
    expect(work.diff).toContain('"MY_API_KEY": "<redacted>"')
    expect(work.diff).toContain('"SLACK_MCP_XOXP_TOKEN": "${SLACK_MCP_XOXP_TOKEN:-}"')
    expect(drifts[2].diff).toContain("- old-notes -> ")
  })
})

describe("GET /api/inscope/workspaces/:name", () => {
  test("returns one workspace with its identity, checks, and pending changes", async () => {
    const detail = await data("/workspaces/work")
    expect(detail.workspace.name).toBe("work")
    expect(detail.identity.claude.email).toBe("work@example.com")
    expect(detail.checks.every((c: { label: string }) => c.label.startsWith("[work] "))).toBe(true)
    expect(detail.drifts.map((d: { label: string }) => d.label)).toEqual([
      "mcp:work",
      "skills:work",
    ])
  })

  test("a shared workspace owns the shared skills drift, not one named after it", async () => {
    const detail = await data("/workspaces/personal")
    expect(detail.drifts).toEqual([])
    expect(detail.identity.claude.isolated).toBe(false)
  })

  test("404s an unknown workspace and 400s a name inscope could never hold", async () => {
    const unknown = await send("/workspaces/nope")
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({
      error: { code: "NOT_FOUND", message: 'No workspace named "nope"' },
    })
    const bad = await send("/workspaces/bad%20name")
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe("VALIDATION_ERROR")
  })
})

describe("no response carries a credential", () => {
  test("not a token, keychain value, or literal key from .mcp.json, on any route", async () => {
    for (const route of [
      "/",
      "/status",
      "/doctor",
      "/diff",
      "/workspaces/personal",
      "/workspaces/work",
      "/workspaces/acme",
    ]) {
      const body = await (await send(route)).text()
      for (const secret of SECRETS)
        expect(`${route}: ${body.includes(secret)}`).toBe(`${route}: false`)
    }
  })
})

describe("the config file's own states", () => {
  const configFile = () => path.join(sb.home, ".config", "inscope", "inscope.json")

  test("an invalid config is the user's to fix: 422 with inscope's own message", async () => {
    const original = fs.readFileSync(configFile(), "utf8")
    try {
      fs.writeFileSync(
        configFile(),
        JSON.stringify({
          version: 1,
          workspaces: [{ name: "bad name", path: "~/w", servers: {} }],
        }),
      )
      const res = await send("/")
      expect(res.status).toBe(422)
      const { error } = await res.json()
      expect(error.code).toBe("INSCOPE_CONFIG_INVALID")
      expect(error.message).toContain("Fix it in ~/.config/inscope/inscope.json")
    } finally {
      fs.writeFileSync(configFile(), original)
    }
  })

  test("no config yet is not an error: empty lists everywhere", async () => {
    const original = fs.readFileSync(configFile(), "utf8")
    try {
      fs.rmSync(configFile())
      expect((await data("/")).config.exists).toBe(false)
      expect((await data("/")).workspaces).toEqual([])
      expect((await data("/status")).workspaces).toEqual([])
      expect((await data("/doctor")).checks).toEqual([])
      expect(await data("/diff")).toEqual({ adoptable: [], drifts: [] })
      expect((await send("/workspaces/work")).status).toBe(404)
    } finally {
      fs.writeFileSync(configFile(), original)
    }
  })
})
