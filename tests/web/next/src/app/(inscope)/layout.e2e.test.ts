import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"

import { PAGES } from "../../../../../inscope/pages"
import { SECRETS } from "../../../../../inscope/sandbox"
import { enabled, WEB } from "../../../../../stack"

// web/next/src/app/(inscope), the dashboard at the site's root, and its pages on the stack tests/inscope/serve.ts starts on a sealed sandbox: the shell over HTTP, then, where agent-browser is installed, each page as a browser renders it, since every page fetches its data client-side.
const SANDBOX = process.env.E2E_INSCOPE_SANDBOX ?? ""
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? ""

describe.skipIf(!enabled || !SANDBOX)("web/next/src/app/(inscope) over HTTP", () => {
  test("every page renders inside the dashboard shell, with no marketing navbar", async () => {
    for (const { path: page } of PAGES) {
      const res = await fetch(`${WEB}${page}`)
      expect(`${page} ${res.status}`).toBe(`${page} 200`)
      const html = await res.text()
      for (const label of ["Workspaces", "Skills", "Doctor", "Pending changes", "Local, read-only"])
        expect(html).toContain(label)
      expect(html).toContain('data-sidebar="sidebar"')
    }
  })

  test("a workspace no config has answers 404 inside the shell; an unknown path gets the site's own 404", async () => {
    const workspace = await fetch(`${WEB}/workspaces/bad%20name`)
    expect(workspace.status).toBe(404)
    expect(await workspace.text()).toContain("Back to workspaces")
    const unknown = await fetch(`${WEB}/no/such/page`)
    expect(unknown.status).toBe(404)
    expect(await unknown.text()).not.toContain('data-sidebar="sidebar"')
  })
})

const browser = Bun.which("agent-browser")

// one isolated agent-browser session for the file; every command throws on failure so a test reads straight through
const ab = (...args: string[]) => {
  const res = Bun.spawnSync(["agent-browser", ...args], {
    env: { ...process.env, AGENT_BROWSER_SESSION: "inscope-e2e" },
  })
  if (res.exitCode !== 0)
    throw new Error(`agent-browser ${args.join(" ")}: ${res.stderr.toString()}`)
  return res.stdout.toString().trim()
}

const visit = (page: string, waitFor: string) => {
  ab("open", `${WEB}${page}`)
  ab("wait", "--text", waitFor)
}

const shoot = (name: string) => {
  if (SHOTS) ab("screenshot", path.join(SHOTS, `${name}.png`))
}

describe.skipIf(!enabled || !SANDBOX || !browser)("web/next/src/app/(inscope) in a browser", () => {
  beforeAll(() => {
    ab("set", "viewport", "1782", "972")
    ab("set", "media", "light")
  })

  afterAll(() => {
    ab("close")
  })

  test("the overview shows every workspace's state once its data arrives", () => {
    visit("/", "MCP not written")
    const text = ab("get", "text", "main")
    for (const state of [
      "Signed in as personal@example.com",
      "Signed in as work@example.com",
      "Not signed in",
      "GitHub demo-acme: no token",
      "MCP in sync",
      "MCP drifted",
      "MCP not written",
    ])
      expect(text).toContain(state)
    shoot("overview")
  })

  test("a workspace card opens that workspace", () => {
    visit("/", "MCP drifted")
    ab("find", "text", "~/work", "click")
    ab("wait", "--url", "**/workspaces/work")
    // a label only the loaded page has; "Pending changes" is also in the sidebar
    ab("wait", "--text", "Claude login")
    const text = ab("get", "text", "main")
    for (const part of [
      "Identity",
      "MCP servers",
      "Skills",
      "Checks",
      "remote",
      "yours",
      "<redacted>",
    ])
      expect(text).toContain(part)
    shoot("workspace-work")
  })

  test("a name no workspace has shows the not-found page, whether it arrives encoded or not", () => {
    for (const name of ["nope", "bad!name", "bad%20name", "caf%C3%A9"]) {
      visit(`/workspaces/${name}`, "No such workspace")
      expect(`${name} ${ab("get", "text", "main").includes("Not available here")}`).toBe(
        `${name} false`,
      )
    }
  })

  test("doctor, skills, and pending changes render their data", () => {
    visit("/doctor", "[acme] gh")
    expect(ab("get", "text", "main")).toContain("no token for demo-acme")
    shoot("doctor")
    visit("/skills", "old-notes")
    expect(ab("get", "text", "main")).toContain("inscope link no workspace declares")
    shoot("skills")
    visit("/diff", "Hand edits apply would undo")
    const diff = ab("get", "text", "main")
    expect(diff).toContain('"MY_API_KEY": "<redacted>"')
    expect(diff).toContain("https://mcp.example.com/sse?<redacted>")
    shoot("diff")
  })

  test("no rendered page carries a credential from the sandbox", () => {
    for (const { loaded, path: page } of PAGES) {
      visit(page, loaded)
      const dom = ab("eval", "document.documentElement.outerHTML")
      for (const secret of SECRETS)
        expect(`${page}: ${dom.includes(secret)}`).toBe(`${page}: false`)
    }
  })

  test("no page overflows a phone's width", () => {
    ab("set", "viewport", "390", "844")
    for (const { loaded, path: page } of PAGES) {
      visit(page, loaded)
      expect(
        `${page} ${ab("eval", "document.documentElement.scrollWidth <= document.documentElement.clientWidth")}`,
      ).toBe(`${page} true`)
      shoot(`phone${page.replaceAll("/", "-")}`)
    }
    ab("set", "viewport", "1782", "972")
  })
})
