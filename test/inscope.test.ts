import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { renderZshrcSource } from "@/apply"
import {
  findWorkspace,
  hookValueError,
  labelFromPath,
  removeWorkspace,
  slugify,
  upsertWorkspace,
  validateConfig,
  workspaceNameError,
  workspacePathError,
  type Config,
} from "@/config"
import { currentWorkspace } from "@/doctor"
import { adoptable, diffLines, mcpError, mcpTarget } from "@/drift"
import { configPath, gitIncludeDir, hookPath } from "@/env"
import { renderGitInclude, renderPerWorkspaceGitconfig } from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { applyMcp, removeMcp, renderServers } from "@/generators/mcp"
import { readBlock, removeBlock, upsertBlock } from "@/managed-block"
import { ghAccounts, gitGlobal, type Runner } from "@/secrets"
import { buildServers, enabledServers, slackKeychainFor } from "~/bin/commands/_workspace"

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
        slack: { keychain: "SLACK_MCP_XOXP_TOKEN_ACME", addMessageTool: true },
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
        slack: {
          keychain: "SLACK_MCP_XOXP_TOKEN_NRJDALAL",
          addMessageTool: true,
        },
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
  ws.servers.slack = { keychain: "SLACK_MCP_XOXP_TOKEN_ACME" }
  const slack = renderServers(ws)["slack-acme"] as any
  expect(slack.env.SLACK_MCP_ADD_MESSAGE_TOOL).toBeUndefined()
})

test("renderHook wires both workspaces and is deterministic", () => {
  const hook = renderHook(blogConfig())
  expect(hook).toContain(`"$HOME/acme/"*) ws="acme" ;;`)
  expect(hook).toContain(`"$HOME/nrjdalal/"*) ws="nrjdalal" ;;`)
  expect(hook).toContain(`acme) gh_user="acme"; slack_svc="SLACK_MCP_XOXP_TOKEN_ACME" ;;`)
  expect(hook).toContain(
    `nrjdalal) gh_user="nrjdalal"; slack_svc="SLACK_MCP_XOXP_TOKEN_NRJDALAL" ;;`,
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
    workspaces: [{ name: "docs", path: "~/docs", git: { email: "me@x.dev" }, servers: {} }],
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
  const file = path.join(dir, ".gitconfig")
  fs.writeFileSync(file, "[core]\n\tpager = less\n")

  upsertBlock(file, "gitconfig", "source x")
  const once = fs.readFileSync(file, "utf8")
  upsertBlock(file, "gitconfig", "source x")
  expect(fs.readFileSync(file, "utf8")).toBe(once)

  expect(once).toContain("pager = less")
  expect(readBlock(file, "gitconfig")).toBe("source x")

  upsertBlock(file, "gitconfig", "source y")
  expect(readBlock(file, "gitconfig")).toBe("source y")

  removeBlock(file, "gitconfig")
  expect(readBlock(file, "gitconfig")).toBeNull()
  expect(fs.readFileSync(file, "utf8")).toContain("pager = less")
})

test("managed block has no leading blank line on a fresh file", () => {
  const file = path.join(tmpDir(), ".gitconfig")
  upsertBlock(file, "gitconfig", "source x")
  upsertBlock(file, "gitconfig", "source y")
  const out = fs.readFileSync(file, "utf8")
  expect(out.startsWith("# >>> inscope:gitconfig >>>")).toBe(true)
  expect(out.match(/# >>> inscope:gitconfig >>>/g)).toHaveLength(1)
})

test("renderZshrcSource appends the source line once and stays idempotent", () => {
  const once = renderZshrcSource("export FOO=1\n")
  expect(once).toContain("export FOO=1")
  expect(once).toContain('source "$HOME/.config/inscope/inscope.zsh"')
  expect(once).not.toContain("# >>> inscope")
  expect(once.match(/&& source /g)).toHaveLength(1)
  expect(renderZshrcSource(once)).toBe(once)
})

test("renderZshrcSource has no leading blank line on a fresh file", () => {
  expect(renderZshrcSource("").startsWith("# inscope:")).toBe(true)
})

test("ghAccounts parses unique accounts and ignores the active-account line", () => {
  const run: Runner = () => ({
    status: 0,
    stdout: [
      "github.com",
      "  ✓ Logged in to github.com account nrjdalal (GITHUB_TOKEN)",
      "  - Active account: true",
      "  ✓ Logged in to github.com account nrjdalal (keyring)",
      "  ✓ Logged in to github.com account neeraj-acme-org (keyring)",
    ].join("\n"),
    stderr: "",
  })
  expect(ghAccounts(run)).toEqual(["nrjdalal", "neeraj-acme-org"])
})

test("slackKeychainFor names the keychain after the env var, uppercased", () => {
  expect(slackKeychainFor("acme")).toBe("SLACK_MCP_XOXP_TOKEN_ACME")
  expect(slackKeychainFor("brand-new")).toBe("SLACK_MCP_XOXP_TOKEN_BRAND_NEW")
  expect(slackKeychainFor("a.b c")).toBe("SLACK_MCP_XOXP_TOKEN_A_B_C")
})

test("buildServers reflects the enabled list and slack details", () => {
  const s = buildServers(["github", "linear"], null)
  expect(s.github).toBe(true)
  expect(s.linear).toBe(true)
  expect(s.notion).toBe(false)
  expect(s.stripe).toBe(false)
  expect(s.slack).toBe(false)

  const withSlack = buildServers(["github", "slack"], {
    keychain: "K",
    addMessageTool: true,
  })
  expect(withSlack.github).toBe(true)
  expect(withSlack.linear).toBe(false)
  expect(withSlack.slack).toEqual({ keychain: "K", addMessageTool: true })
})

test("renderServers emits each OAuth http server at its endpoint", () => {
  const out = renderServers({
    name: "x",
    path: "~/x",
    servers: { atlassian: true, plane: true, sentry: true, vercel: true },
  })
  expect(out["atlassian-x"]).toEqual({
    type: "http",
    url: "https://mcp.atlassian.com/v1/mcp",
  })
  expect(out["plane-x"]).toEqual({
    type: "http",
    url: "https://mcp.plane.so/http/mcp",
  })
  expect(out["sentry-x"]).toEqual({
    type: "http",
    url: "https://mcp.sentry.dev/mcp",
  })
  expect(out["vercel-x"]).toEqual({
    type: "http",
    url: "https://mcp.vercel.com",
  })

  const out2 = renderServers({
    name: "y",
    path: "~/y",
    servers: {
      canva: true,
      clickup: true,
      hubspot: true,
      monday: true,
      stripe: true,
      webflow: true,
    },
  })
  expect(out2["canva-y"]).toEqual({
    type: "http",
    url: "https://mcp.canva.com/mcp",
  })
  expect(out2["clickup-y"]).toEqual({
    type: "http",
    url: "https://mcp.clickup.com/mcp",
  })
  expect(out2["hubspot-y"]).toEqual({
    type: "http",
    url: "https://mcp.hubspot.com",
  })
  expect(out2["monday-y"]).toEqual({
    type: "http",
    url: "https://mcp.monday.com/mcp",
  })
  expect(out2["stripe-y"]).toEqual({
    type: "http",
    url: "https://mcp.stripe.com",
  })
  expect(out2["webflow-y"]).toEqual({
    type: "http",
    url: "https://mcp.webflow.com/",
  })
})

test("enabledServers lists only enabled servers, in order", () => {
  expect(enabledServers({ github: true, linear: false, notion: true, slack: false })).toEqual([
    "github",
    "notion",
  ])
  expect(
    enabledServers({
      github: true,
      linear: true,
      notion: true,
      slack: { keychain: "K" },
    }),
  ).toEqual(["github", "linear", "notion", "slack"])
})

test("gitGlobal returns the trimmed value or null", () => {
  const ok: Runner = () => ({ status: 0, stdout: "me@x.dev\n", stderr: "" })
  expect(gitGlobal("user.email", ok)).toBe("me@x.dev")
  const empty: Runner = () => ({ status: 0, stdout: "\n", stderr: "" })
  expect(gitGlobal("user.email", empty)).toBeNull()
  const fail: Runner = () => ({ status: 1, stdout: "", stderr: "" })
  expect(gitGlobal("user.email", fail)).toBeNull()
})

test("config, hook, and git paths live under ~/.config/inscope", () => {
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = "/tmp/inscope-xdg"
  try {
    expect(configPath()).toBe("/tmp/inscope-xdg/inscope/inscope.json")
    expect(hookPath()).toBe("/tmp/inscope-xdg/inscope/inscope.zsh")
    expect(gitIncludeDir()).toBe("/tmp/inscope-xdg/inscope/git")
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  }
})

test("currentWorkspace matches the enclosing workspace by path", () => {
  const cfg: Config = {
    version: 1,
    workspaces: [
      { name: "acme", path: "/tmp/acme", servers: {} },
      { name: "blog", path: "/tmp/blog", servers: {} },
    ],
  }
  expect(currentWorkspace(cfg, "/tmp/acme/api")?.name).toBe("acme")
  expect(currentWorkspace(cfg, "/tmp/blog")?.name).toBe("blog")
  expect(currentWorkspace(cfg, "/tmp/other")).toBeUndefined()
})

test("applyMcp merges with, and removeMcp prunes, only inscope's servers", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".mcp.json")
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { custom: { type: "http", url: "x" } } }))

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

test("applyMcp refuses to clobber a malformed .mcp.json", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".mcp.json")
  const malformed = '{ "mcpServers": { '
  fs.writeFileSync(file, malformed)

  const ws = { name: "acme", path: dir, servers: { github: true } }
  expect(() => applyMcp(ws)).toThrow(/not valid JSON/)
  expect(fs.readFileSync(file, "utf8")).toBe(malformed)
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

test("slugify and labelFromPath produce hook-safe names", () => {
  expect(slugify("My Project")).toBe("my-project")
  expect(slugify("Acme (work)")).toBe("acme-work")
  expect(slugify("a.b_c-1")).toBe("a.b_c-1")
  // basename is slugified, so a directory with spaces never yields a name that
  // would break the generated hook
  expect(labelFromPath("~/My Project")).toBe("my-project")
})

test("workspaceNameError accepts slugs and rejects shell metacharacters", () => {
  expect(workspaceNameError("acme")).toBeNull()
  expect(workspaceNameError("a.b-c_1")).toBeNull()
  expect(workspaceNameError("")).not.toBeNull()
  expect(workspaceNameError("My Project")).not.toBeNull()
  expect(workspaceNameError("foo;rm -rf ~")).not.toBeNull()
  expect(workspaceNameError("a/b")).not.toBeNull()
})

test("workspacePathError rejects characters that break the hook quoting", () => {
  expect(workspacePathError("~/acme")).toBeNull()
  expect(workspacePathError("~/My Project")).toBeNull() // spaces are fine, the pattern is quoted
  expect(workspacePathError('~/a"b')).not.toBeNull()
  expect(workspacePathError("~/a`b")).not.toBeNull()
  expect(workspacePathError("~/a$b")).not.toBeNull()
})

test("hookValueError rejects shell-substitution metacharacters even when quoted", () => {
  // quoting does not neutralize these inside zsh double quotes
  expect(hookValueError("SLACK_MCP_XOXP_TOKEN_ACME")).toBeNull()
  expect(hookValueError("com.acme.slack token")).toBeNull() // spaces/dots are fine
  expect(hookValueError("$(rm -rf ~)")).not.toBeNull()
  expect(hookValueError("`id`")).not.toBeNull()
  expect(hookValueError('a"b')).not.toBeNull()
  expect(hookValueError("$HOME")).not.toBeNull()
})

test("validateConfig rejects an unsafe name, path, gh, or keychain from a hand-edited config", () => {
  expect(() =>
    validateConfig({
      version: 1,
      workspaces: [{ name: "my project", path: "~/x", servers: {} }],
    }),
  ).toThrow(/name "my project" is invalid/)

  expect(() =>
    validateConfig({
      version: 1,
      workspaces: [{ name: "ok", path: "~/a`b", servers: {} }],
    }),
  ).toThrow(/path .* is invalid/)

  expect(() =>
    validateConfig({
      version: 1,
      workspaces: [{ name: "ok", path: "~/x", gh: "$(id)", servers: { github: true } }],
    }),
  ).toThrow(/gh account .* is invalid/)

  expect(() =>
    validateConfig({
      version: 1,
      workspaces: [
        {
          name: "ok",
          path: "~/x",
          servers: { slack: { keychain: "$(rm -rf ~)" } },
        },
      ],
    }),
  ).toThrow(/Slack keychain .* is invalid/)
})

test("diffLines marks unchanged, removed, and added lines", () => {
  const d = diffLines("a\nb\nc", "a\nB\nc\nd")
  expect(d).toContain("  a")
  expect(d).toContain("- b")
  expect(d).toContain("+ B")
  expect(d).toContain("  c")
  expect(d).toContain("+ d")
})

test("mcpTarget previews apply: keeps custom keys, refreshes managed, no write", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".mcp.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        custom: { type: "http", url: "x" },
        "github-acme": { type: "http", url: "STALE" },
      },
    }),
  )

  const out = JSON.parse(mcpTarget({ name: "acme", path: dir, servers: { github: true } }))
  expect(out.mcpServers.custom).toEqual({ type: "http", url: "x" })
  expect(out.mcpServers["github-acme"].url).toBe("https://api.githubcopilot.com/mcp/")
  // pure: the on-disk file is untouched
  expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["github-acme"].url).toBe("STALE")
})

test("adoptable back-syncs a config-expressible on-disk setting, idempotently", () => {
  const dir = tmpDir()
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "slack-acme": {
          type: "stdio",
          command: "npx",
          args: ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"],
          env: {
            SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN}",
            SLACK_MCP_ADD_MESSAGE_TOOL: "true",
          },
        },
      },
    }),
  )

  const cfg: Config = {
    version: 1,
    workspaces: [{ name: "acme", path: dir, servers: { slack: { keychain: "K" } } }],
  }

  const { cfg: next, changes } = adoptable(cfg)
  expect(changes).toContain("acme: slack.addMessageTool = true")
  expect(next.workspaces[0].servers.slack).toEqual({ keychain: "K", addMessageTool: true })

  // once the config covers it, there is nothing left to adopt
  expect(adoptable(next).changes).toHaveLength(0)
})

test("adoptable adopts a custom remote URL but leaves a default one alone", () => {
  const dir = tmpDir()
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "linear-acme": { type: "http", url: "https://mcp.linear.app/custom" },
        "notion-acme": { type: "http", url: "https://mcp.notion.com/mcp" },
      },
    }),
  )

  const cfg: Config = {
    version: 1,
    workspaces: [{ name: "acme", path: dir, servers: { linear: true, notion: true } }],
  }

  const { cfg: next, changes } = adoptable(cfg)
  expect(changes).toContain("acme: linear.url = https://mcp.linear.app/custom")
  expect(changes.some((c) => c.startsWith("acme: notion"))).toBe(false)
  expect(next.workspaces[0].servers.linear).toEqual({ url: "https://mcp.linear.app/custom" })
  expect(next.workspaces[0].servers.notion).toBe(true)
})

test("adoptable adopts a remote server present only on disk", () => {
  const dir = tmpDir()
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "notion-acme": { type: "http", url: "https://mcp.notion.com/mcp" } },
    }),
  )

  const cfg: Config = {
    version: 1,
    workspaces: [{ name: "acme", path: dir, servers: { github: true } }],
  }

  const { cfg: next, changes } = adoptable(cfg)
  expect(changes).toContain("acme: notion = enabled")
  expect(next.workspaces[0].servers.notion).toBe(true)
})

test("mcpError flags a malformed .mcp.json and clears once valid", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".mcp.json")
  const ws = { name: "acme", path: dir, servers: { github: true } }

  fs.writeFileSync(file, '{ "mcpServers": {')
  expect(mcpError(ws)).toContain("invalid JSON")

  fs.writeFileSync(file, '{ "mcpServers": {} }')
  expect(mcpError(ws)).toBeNull()
})
