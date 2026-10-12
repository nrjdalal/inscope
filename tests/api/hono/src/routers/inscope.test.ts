import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { createInscopeRouter } from "../../../../../api/hono/src/routers/inscope"
import { ROUTES } from "../../../../inscope/pages"
import { SECRETS, type Sandbox, seedSandbox, UNSEALED } from "../../../../inscope/sandbox"

const TRUSTED = "http://inscope.localhost:1355"

let sb: Sandbox
const saved: Record<string, string | undefined> = {}

// the library reads HOME, XDG_CONFIG_HOME and PATH at call time, so the sealed env goes on this process for the file and comes off after
beforeAll(async () => {
  sb = await seedSandbox()
  for (const [key, value] of Object.entries(sb.env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  for (const key of UNSEALED) {
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
    // with no Bun server behind the request, getConnInfo cannot read a peer at all
    const unreadable = createInscopeRouter({ stage: "local", trustedOrigins: [] })
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

  test("refuses a request a proxy on this machine relayed for another host or client", async () => {
    // next dev forwards /api to the API from loopback with the Host rewritten, so the hop it came from is only in these headers
    for (const headers of [
      { "x-forwarded-host": "rebind.attacker.test:3000" },
      { "x-forwarded-host": "localhost:3000", "x-forwarded-for": "192.168.68.105" },
      { "x-forwarded-for": "127.0.0.1, 10.0.0.9" },
      { "x-real-ip": "10.0.0.9" },
      { forwarded: 'for="[2001:db8::1]:4711";host=localhost:3000' },
      { forwarded: "for=127.0.0.1;host=evil.example" },
      { forwarded: "for=unknown" },
      // next dev's /api forwarding names no client and passes the caller's own Host along
      { "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" },
      { via: "1.1 proxy" },
    ] as Record<string, string>[]) {
      const res = await send("/", { headers })
      expect(`${JSON.stringify(headers)} ${res.status}`).toBe(`${JSON.stringify(headers)} 403`)
    }
  })

  test("admits a proxy on this machine relaying a loopback request it names (portless)", async () => {
    for (const headers of [
      { "x-forwarded-host": "api.inscope.localhost:1355", "x-forwarded-for": "127.0.0.1" },
      { "x-forwarded-host": "localhost:3000", "x-forwarded-for": "::1" },
      { forwarded: 'for="[::1]:51234";host=localhost:3000;proto=http' },
    ] as Record<string, string>[])
      expect((await send("/", { headers })).status).toBe(200)
  })

  test("refuses an encoded path, which next dev's rewrite would not recognize as inscope's", async () => {
    for (const route of ["/st%61tus", "/%64iff", "/workspaces/w%6Frk"]) {
      const res = await send(route)
      expect(`${route} ${res.status}`).toBe(`${route} 403`)
    }
  })

  test("never caches a response, the gate's own refusals included", async () => {
    expect((await send("/")).headers.get("cache-control")).toBe("no-store")
    expect((await send("/", {}, "evil.example:4000")).headers.get("cache-control")).toBe("no-store")
    expect((await send("/", { stage: "production" })).headers.get("cache-control")).toBe("no-store")
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
      mcp: { error: null, path: "~/personal/.mcp.json", state: "in-sync", types: ["github"] },
      skills: {
        dir: "~/.claude/skills",
        other: [],
        own: [{ linked: true, name: "inscope", source: null }],
      },
    })
    expect(work.isolated).toBe(true)
    expect(work.mcp.state).toBe("drifted")
    expect(work.mcp.types).toEqual(["github", "linear", "slack"])
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
      {
        kind: "stale",
        label: "inscope link no workspace declares (the next apply removes it)",
        name: "old-private",
        target: null,
        workspace: null,
      },
    ])
    expect(acme.mcp.state).toBe("missing")
    // a git source's token is withheld, its host kept
    expect(acme.skills.own).toEqual([
      { linked: true, name: "inscope", source: null },
      {
        linked: false,
        name: "plain-skills",
        source: "https://git.example.com/org/plain-skills.git",
      },
      {
        linked: false,
        name: "private-skills",
        source: "https://<redacted>@git.example.com/org/private-skills.git",
      },
    ])
    // server names only: inscope's own for the workspace, the user's hand-added ones, and whether each is written yet
    expect(work.mcp.servers).toEqual([
      { managed: true, name: "github-work", written: true },
      { managed: false, name: "keycloak", written: true },
      { managed: true, name: "linear-work", written: true },
      { managed: false, name: "mine", written: true },
      { managed: false, name: "remote", written: true },
      { managed: true, name: "slack-work", written: true },
      { managed: false, name: "zapier", written: true },
    ])
    expect(
      acme.mcp.servers.every(
        (s: { managed: boolean; written: boolean }) => s.managed && !s.written,
      ),
    ).toBe(true)
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
          configDir: "~/clients/acme-corporation-holdings/engineering/acme/.inscope",
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
      "gitconfig:acme",
      "mcp:work",
      "mcp:acme",
      "skills:work",
      "skills:acme",
    ])
    const drift = (label: string) =>
      drifts.find((d: { label: string }) => d.label === label).diff as string
    const mcp = drift("mcp:work")
    expect(mcp).toContain('-       "url": "https://mcp.linear.app/sse-old"')
    expect(mcp).toContain('+       "url": "https://mcp.linear.app/mcp"')
    expect(mcp).toContain('"MY_API_KEY": "<redacted>"')
    expect(mcp).toContain('"MY_TOKEN": "<redacted>"')
    expect(mcp).toContain('"--api-key",')
    expect(mcp).toContain('"url": "https://mcp.example.com/sse?<redacted>"')
    expect(mcp).toContain('"Authorization": "<redacted>"')
    // not credentials: a server named like one, its client id and port, a write toggle
    expect(mcp).toContain('"clientId": "dashboard-client"')
    expect(mcp).toContain('"callbackPort": 33418')
    expect(mcp).toContain('"SLACK_MCP_ALLOW_WRITE": "false"')
    expect(mcp).toContain('"url": "https://sso.example.com/mcp"')
    expect(mcp).toContain('"SLACK_MCP_XOXP_TOKEN": "${SLACK_MCP_XOXP_TOKEN:-}"')
    expect(mcp).toContain('"url": "https://mcp.zapier.com/api/mcp/s/<redacted>/mcp"')
    // a credential flag inside one string loses its value; a count that only looks like one keeps it
    expect(mcp).toContain('"npx -y @acme/mcp --api-key <redacted>",')
    expect(mcp).toMatch(/"--max-tokens",\n\s+"4096"/)
    // a quoted value keeps its quotes; a token its vendor prefix gives away goes whole
    expect(mcp).toContain('"API_KEY=\\"<redacted>\\"",')
    expect(mcp).toContain(`"--password='<redacted>'",`)
    expect(mcp).toContain('"X-Api-Key: \\"<redacted>\\"",')
    // a hand-edited git include goes through the same string rules
    expect(drift("gitconfig:acme")).toContain('[url "https://<redacted>@github.com/"]')
    expect(drift("gitconfig:acme")).toContain(
      "echo username=x-token-auth; echo password=<redacted>;",
    )
    expect(drift("skills:work")).toContain("- old-notes -> ")
    // a git skill's cache folder is named after its URL: withheld for a link left behind and for one a tokened source would make
    expect(drift("skills:work")).toMatch(/- old-private -> \S+\/skills-cache\/git\/<redacted>$/m)
    expect(drift("skills:acme")).toMatch(
      /\+ private-skills -> \S+\/skills-cache\/git\/<redacted>$/m,
    )
    expect(drift("skills:acme")).toMatch(
      /\+ plain-skills -> \S+\/skills-cache\/git\/git\.example\.com-org-plain-skills-[0-9a-f]{7}$/m,
    )
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
      error: { code: "INSCOPE_WORKSPACE_NOT_FOUND", message: 'No workspace named "nope"' },
    })
    const bad = await send("/workspaces/bad!name")
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe("VALIDATION_ERROR")
  })
})

describe("no response carries a credential", () => {
  test("not a token, keychain value, or literal key from .mcp.json, on any route", async () => {
    for (const route of ROUTES) {
      const body = await (await send(route)).text()
      for (const secret of SECRETS)
        expect(`${route}: ${body.includes(secret)}`).toBe(`${route}: false`)
    }
  })
})

describe("the config file's own states", () => {
  const configFile = () => path.join(sb.home, ".config", "inscope", "inscope.json")

  test("an invalid config is the user's to fix: 422 with inscope's own message", async () => {
    const original = await Bun.file(configFile()).text()
    try {
      await Bun.write(
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
      await Bun.write(configFile(), original)
    }
  })

  test("the 422 never quotes a credential from the invalid value", async () => {
    const original = await Bun.file(configFile()).text()
    try {
      // a skill URL with no path: its name falls back to the whole URL, token and all, which the config refuses
      const skill = "https://x-access-token:config-error-should-be-redacted@git.example.com"
      await Bun.write(
        configFile(),
        JSON.stringify({
          version: 1,
          workspaces: [{ name: "w", path: "~/w", servers: {}, skills: [skill] }],
        }),
      )
      const res = await send("/")
      expect(res.status).toBe(422)
      const { error } = await res.json()
      expect(error.message).not.toContain("config-error-should-be-redacted")
      expect(error.message).toContain("<redacted>@git.example.com")
    } finally {
      await Bun.write(configFile(), original)
    }
  })

  test("no config yet is not an error: empty lists everywhere", async () => {
    const original = await Bun.file(configFile()).text()
    try {
      await Bun.file(configFile()).delete()
      expect((await data("/")).config.exists).toBe(false)
      expect((await data("/")).workspaces).toEqual([])
      expect((await data("/status")).workspaces).toEqual([])
      expect((await data("/doctor")).checks).toEqual([])
      expect(await data("/diff")).toEqual({ adoptable: [], drifts: [] })
      expect((await send("/workspaces/work")).status).toBe(404)
    } finally {
      await Bun.write(configFile(), original)
    }
  })
})
