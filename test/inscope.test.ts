import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  findWorkspace,
  removeWorkspace,
  upsertWorkspace,
  type Config,
} from "@/config"
import {
  renderGitInclude,
  renderPerWorkspaceGitconfig,
} from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { applyMcp, removeMcp, renderServers } from "@/generators/mcp"
import { readBlock, removeBlock, upsertBlock } from "@/managed-block"
import { expect, test } from "bun:test"

const blogConfig = (): Config => ({
  version: 1,
  workspaces: [
    {
      name: "acme",
      path: "~/acme",
      gh: "acme",
      git: { email: "neeraj@acme.com", name: "Neeraj Dalal" },
      servers: {
        github: true,
        linear: true,
        notion: true,
        slack: { keychain: "slack-acme-mcp-xoxp", addMessageTool: true },
      },
    },
    {
      name: "nrjdalal",
      path: "~/nrjdalal",
      gh: "nrjdalal",
      git: { email: "admin@nrjdalal.com" },
      servers: {
        github: true,
        linear: true,
        notion: true,
        slack: { keychain: "slack-nrjdalal-mcp-xoxp", addMessageTool: true },
      },
    },
  ],
})

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "inscope-"))

test("renderServers matches the blog's acme .mcp.json", () => {
  expect(renderServers(blogConfig().workspaces[0])).toEqual({
    "github-acme": {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    },
    "linear-acme": { type: "http", url: "https://mcp.linear.app/mcp" },
    "notion-acme": { type: "http", url: "https://mcp.notion.com/mcp" },
    "slack-acme": {
      type: "stdio",
      command: "npx",
      args: ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"],
      env: {
        SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN}",
        SLACK_MCP_ADD_MESSAGE_TOOL: "true",
      },
    },
  })
})

test("addMessageTool omitted means read-only Slack server", () => {
  const ws = blogConfig().workspaces[0]
  ws.servers.slack = { keychain: "slack-acme-mcp-xoxp" }
  const slack = renderServers(ws)["slack-acme"] as any
  expect(slack.env.SLACK_MCP_ADD_MESSAGE_TOOL).toBeUndefined()
})

test("renderHook wires both workspaces and is deterministic", () => {
  const hook = renderHook(blogConfig())
  expect(hook).toContain(`"$HOME/acme/"*) ws=acme ;;`)
  expect(hook).toContain(`"$HOME/nrjdalal/"*) ws=nrjdalal ;;`)
  expect(hook).toContain(`acme) gh_user=acme; slack_svc=slack-acme-mcp-xoxp ;;`)
  expect(hook).toContain(
    `nrjdalal) gh_user=nrjdalal; slack_svc=slack-nrjdalal-mcp-xoxp ;;`,
  )
  expect(hook).toContain(`unset GITHUB_TOKEN GH_TOKEN SLACK_MCP_XOXP_TOKEN`)
  expect(hook).toContain(`export GITHUB_TOKEN="$tok" GH_TOKEN="$tok"`)
  expect(hook).toContain(`add-zsh-hook chpwd __inscope_resolve_identity`)
  expect(hook).toContain(`__inscope_ws="__init__"`)
  expect(renderHook(blogConfig())).toBe(hook)
})

test("a workspace without gh or slack produces a no-op hook arm", () => {
  const cfg: Config = {
    version: 1,
    workspaces: [
      { name: "docs", path: "~/docs", git: { email: "me@x.dev" }, servers: {} },
    ],
  }
  expect(renderHook(cfg)).toContain(`docs) : ;;`)
})

test("git includes and per-workspace gitconfig", () => {
  const include = renderGitInclude(blogConfig())
  expect(include).toContain(`[includeIf "gitdir:~/acme/"]`)
  expect(include).toContain(`acme.gitconfig`)
  expect(include).toContain(`[includeIf "gitdir:~/nrjdalal/"]`)

  expect(renderPerWorkspaceGitconfig(blogConfig().workspaces[0])).toBe(
    "# Managed by inscope. Do not edit by hand.\n[user]\n\temail = neeraj@acme.com\n\tname = Neeraj Dalal\n",
  )
  expect(renderPerWorkspaceGitconfig(blogConfig().workspaces[1])).toBe(
    "# Managed by inscope. Do not edit by hand.\n[user]\n\temail = admin@nrjdalal.com\n",
  )
})

test("managed block is idempotent and preserves surrounding content", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".zshrc")
  fs.writeFileSync(file, "export FOO=1\n")

  upsertBlock(file, "zshrc", "source x")
  const once = fs.readFileSync(file, "utf8")
  upsertBlock(file, "zshrc", "source x")
  expect(fs.readFileSync(file, "utf8")).toBe(once)

  expect(once).toContain("export FOO=1")
  expect(readBlock(file, "zshrc")).toBe("source x")

  upsertBlock(file, "zshrc", "source y")
  expect(readBlock(file, "zshrc")).toBe("source y")

  removeBlock(file, "zshrc")
  expect(readBlock(file, "zshrc")).toBeNull()
  expect(fs.readFileSync(file, "utf8")).toContain("export FOO=1")
})

test("managed block has no leading blank line on a fresh file", () => {
  const file = path.join(tmpDir(), ".zshrc")
  upsertBlock(file, "zshrc", "source x")
  upsertBlock(file, "zshrc", "source y")
  const out = fs.readFileSync(file, "utf8")
  expect(out.startsWith("# >>> inscope:zshrc >>>")).toBe(true)
  expect(out.match(/# >>> inscope:zshrc >>>/g)).toHaveLength(1)
})

test("applyMcp merges with, and removeMcp prunes, only inscope's servers", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".mcp.json")
  fs.writeFileSync(
    file,
    JSON.stringify({ mcpServers: { custom: { type: "http", url: "x" } } }),
  )

  const ws = { name: "acme", path: dir, servers: { github: true } }
  applyMcp(ws)
  let doc = JSON.parse(fs.readFileSync(file, "utf8"))
  expect(doc.mcpServers.custom).toBeDefined()
  expect(doc.mcpServers["github-acme"]).toBeDefined()

  removeMcp(ws)
  doc = JSON.parse(fs.readFileSync(file, "utf8"))
  expect(doc.mcpServers.custom).toBeDefined()
  expect(doc.mcpServers["github-acme"]).toBeUndefined()
})

test("config upsert and remove by name or path", () => {
  let cfg: Config = { version: 1, workspaces: [] }
  cfg = upsertWorkspace(cfg, {
    name: "acme",
    path: "~/acme",
    servers: { github: true },
  })
  expect(cfg.workspaces).toHaveLength(1)

  cfg = upsertWorkspace(cfg, {
    name: "acme",
    path: "~/acme",
    gh: "acme",
    servers: { github: true },
  })
  expect(cfg.workspaces).toHaveLength(1)
  expect(findWorkspace(cfg, "acme")?.gh).toBe("acme")

  const { cfg: after, removed } = removeWorkspace(cfg, "~/acme")
  expect(removed?.name).toBe("acme")
  expect(after.workspaces).toHaveLength(0)
})
