import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { applyAll, renderZshrcSource } from "@/apply"
import {
  CONFIG_VERSION,
  findWorkspace,
  gitValueError,
  hookValueError,
  labelFromPath,
  loadConfig,
  pathConflict,
  removeWorkspace,
  saveConfig,
  slugify,
  upsertWorkspace,
  validateConfig,
  workspaceNameError,
  workspacePathError,
  type Config,
} from "@/config"
import { currentWorkspace, runDoctor } from "@/doctor"
import { adoptable, diffLines, mcpError, mcpTarget } from "@/drift"
import { configPath, gitIncludeDir, home, hookPath, zshrcPath } from "@/env"
import {
  applyGitconfig,
  perWorkspaceGitconfigPath,
  renderGitInclude,
  renderPerWorkspaceGitconfig,
} from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import {
  applyIsolation,
  inscopeDirPath,
  inscopeSignedIn,
  isInscopeIgnored,
  renderGitignore,
} from "@/generators/isolate"
import { applyMcp, removeMcp, renderServers, slackPackageFromArgs } from "@/generators/mcp"
import {
  applyBypass,
  hasBypassSetting,
  inscopeSettingsPath,
  mergeBypassSettings,
} from "@/generators/settings"
import { writeFileAtomic } from "@/io"
import { readBlock, removeBlock, upsertBlock } from "@/managed-block"
import { ghAccounts, gitGlobal, type Runner } from "@/secrets"
import {
  buildServers,
  enabledServers,
  gitGlobalHint,
  persist,
  resolveSlackPackage,
  slackKeychainFor,
} from "~/bin/commands/_workspace"

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
      // token fetched at connect time (launcher-agnostic), not from the shell env
      headersHelper: `printf '{"Authorization":"Bearer %s"}' "$(gh auth token -u 'acme' 2>/dev/null)"`,
    },
    "linear-acme": { type: "http", url: "https://mcp.linear.app/mcp" },
    "notion-acme": { type: "http", url: "https://mcp.notion.com/mcp" },
    "slack-acme": {
      type: "stdio",
      command: "npx",
      args: ["-y", "@nrjdalal/slack-mcp-server@latest"],
      env: {
        SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN:-}",
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

test("github with a gh account uses headersHelper; without one, a defaulted env token", () => {
  // with gh: token fetched at connect (launcher-agnostic), no static header
  const withGh = renderServers({
    name: "acme",
    path: "~/acme",
    gh: "acme",
    servers: { github: true },
  })["github-acme"] as any
  expect(withGh.headersHelper).toContain("gh auth token -u 'acme'")
  expect(withGh.headers).toBeUndefined()
  // without gh: the ambient token, defaulted (`:-`) so an unset var degrades this
  // one server instead of failing the whole .mcp.json to parse
  const noGh = renderServers({ name: "x", path: "~/x", servers: { github: true } })[
    "github-x"
  ] as any
  expect(noGh.headersHelper).toBeUndefined()
  expect(noGh.headers).toEqual({ Authorization: "Bearer ${GITHUB_TOKEN:-}" })
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

test("renderHook adds no claude() wrapper when no workspace is isolated", () => {
  expect(renderHook(blogConfig())).not.toContain("claude()")
  expect(renderHook(blogConfig())).not.toContain("CLAUDE_CONFIG_DIR")
})

test("renderHook exports each isolated workspace's .inscope login, resolved from $PWD", () => {
  const cfg: Config = {
    version: 1,
    workspaces: [
      { name: "acme", path: "~/acme", isolate: true, servers: { github: true } },
      { name: "personal", path: "~/personal", gh: "nrjdalal", servers: { github: true } },
    ],
  }
  const hook = renderHook(cfg)
  // the base login is captured once (honoring a user's global CLAUDE_CONFIG_DIR,
  // else ~/.claude) so it can be restored outside an isolated subtree
  expect(hook).toContain(`__inscope_base_ccd="\${CLAUDE_CONFIG_DIR-}"`)
  expect(hook).toContain(`local dir="\${__inscope_base_ccd:-$HOME/.claude}"`)
  // each isolated workspace resolves to its local .inscope ...
  expect(hook).toContain(`"$HOME/acme/"*) dir="$HOME/acme/.inscope" ;;`)
  // ... and the login is EXPORTED, so any launcher that inherits the shell (a
  // terminal, cmux, an IDE) runs on it, not just a `claude` typed here
  expect(hook).toContain(`export CLAUDE_CONFIG_DIR="$dir"`)
  // a non-isolated, non-nested workspace contributes no CCD arm (only its token arm)
  expect(hook).not.toContain(`"$HOME/personal/"*) dir=`)
  // the launch is no longer a claude() shell function (it collided with cmux's own)
  expect(hook).not.toContain("claude() {")
  expect(hook).not.toContain("command claude")
})

test("renderHook shadows a non-isolated workspace nested under an isolated one", () => {
  // ~/acme is isolated; ~/acme/sub is a separate, non-isolated workspace. Without a
  // shadow arm the parent's `"$HOME/acme/"*` would capture the child and hand it the
  // parent's login, disagreeing with the token resolver that maps it to its own ws.
  const cfg: Config = {
    version: 1,
    workspaces: [
      { name: "acme", path: "~/acme", isolate: true, servers: { github: true } },
      { name: "sub", path: "~/acme/sub", gh: "nrjdalal", servers: { github: true } },
      { name: "other", path: "~/other", isolate: false, servers: {} },
    ],
  }
  const hook = renderHook(cfg)
  // the child gets a no-op shadow arm in the CCD pin that keeps the base login...
  expect(hook).toContain(`"$HOME/acme/sub/"*) : ;;`)
  expect(hook).toContain(`"$HOME/acme/"*) dir="$HOME/acme/.inscope" ;;`)
  // ...emitted before the parent arm, so it wins (zsh runs the first match)
  expect(hook.indexOf(`"$HOME/acme/sub/"*) : ;;`)).toBeLessThan(
    hook.indexOf(`"$HOME/acme/"*) dir=`),
  )
  // a non-isolated workspace NOT nested under an isolated one gets no CCD arm
  expect(hook).not.toContain(`"$HOME/other/"*) dir=`)
  expect(hook).not.toContain(`"$HOME/other/"*) : ;;`)
})

test("renderHook isolate arms are most-specific-first and handle spaced/absolute paths", () => {
  const cfg: Config = {
    version: 1,
    workspaces: [
      { name: "root", path: "~", isolate: true, servers: {} },
      { name: "nested", path: "~/work/client", isolate: true, servers: {} },
      { name: "spaced", path: "~/My Client (x)", isolate: true, servers: {} },
      { name: "abs", path: "/opt/srv", isolate: true, servers: {} },
    ],
  }
  const hook = renderHook(cfg)
  expect(hook).toContain(`"$HOME/work/client/"*) dir="$HOME/work/client/.inscope" ;;`)
  expect(hook).toContain(`"$HOME/My Client (x)/"*) dir="$HOME/My Client (x)/.inscope" ;;`)
  expect(hook).toContain(`"/opt/srv/"*) dir="/opt/srv/.inscope" ;;`)
  expect(hook).toContain(`"$HOME/"*) dir="$HOME/.inscope" ;;`)
  // the home-root arm (shortest path) is emitted last, after the nested one
  expect(hook.indexOf(`"$HOME/work/client/"*) dir=`)).toBeLessThan(
    hook.indexOf(`"$HOME/"*) dir="$HOME/.inscope"`),
  )
})

test("renderHook exports CLAUDE_CONFIG_DIR for an isolated workspace (no claude() wrapper)", () => {
  const hook = renderHook({
    version: 1,
    workspaces: [
      { name: "acme", path: "~/acme", isolate: true, servers: {} },
      { name: "personal", path: "~/personal", gh: "x", servers: { github: true } },
    ],
  })
  // the login is resolved from $PWD and EXPORTED in the chpwd hook, so any launcher
  // that inherits the shell (a terminal, cmux, an IDE) runs on it
  expect(hook).toContain(`export CLAUDE_CONFIG_DIR="$dir"`)
  expect(hook).toContain(`local dir="\${__inscope_base_ccd:-$HOME/.claude}"`)
  expect(hook).toContain(`__inscope_base_ccd="\${CLAUDE_CONFIG_DIR-}"`)
  expect(hook).toContain(`"$HOME/acme/"*) dir="$HOME/acme/.inscope" ;;`)
  // the launch is no longer a claude() shell function (it collided with cmux's own),
  // and the removed top-level launch flags leave no trace
  expect(hook).not.toContain(`claude() {`)
  expect(hook).not.toContain(`command claude`)
  expect(hook).not.toContain(`--dangerously-skip-permissions`)
})

test("renderHook never touches CLAUDE_CONFIG_DIR when no workspace is isolated", () => {
  const hook = renderHook({
    version: 1,
    workspaces: [{ name: "acme", path: "~/acme", gh: "x", servers: { github: true } }],
  })
  expect(hook).not.toContain("CLAUDE_CONFIG_DIR")
  expect(hook).not.toContain("claude() {")
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

test("buildServers omits the default slack package but keeps a non-default one", () => {
  // default package (@nrjdalal) -> no `package` key, so default configs stay byte-identical
  const def = buildServers(["slack"], {
    keychain: "K",
    addMessageTool: false,
    package: "@nrjdalal/slack-mcp-server",
  })
  expect(def.slack).toEqual({ keychain: "K", addMessageTool: false })

  const koro = buildServers(["slack"], {
    keychain: "K",
    addMessageTool: false,
    package: "slack-mcp-server",
  })
  expect(koro.slack).toEqual({
    keychain: "K",
    addMessageTool: false,
    package: "slack-mcp-server",
  })
})

test("resolveSlackPackage accepts aliases and rejects the unknown", () => {
  expect(resolveSlackPackage(undefined)).toBe("@nrjdalal/slack-mcp-server")
  expect(resolveSlackPackage("")).toBe("@nrjdalal/slack-mcp-server")
  expect(resolveSlackPackage("default")).toBe("@nrjdalal/slack-mcp-server")
  expect(resolveSlackPackage("nrjdalal")).toBe("@nrjdalal/slack-mcp-server")
  expect(resolveSlackPackage("@nrjdalal/slack-mcp-server")).toBe("@nrjdalal/slack-mcp-server")
  expect(resolveSlackPackage("korotovsky")).toBe("slack-mcp-server")
  expect(resolveSlackPackage("some-other-pkg")).toBeNull()
})

test("renderServers shapes the @nrjdalal slack fork per its own CLI", () => {
  const fork = (s: any) =>
    renderServers({ name: "x", path: "~/x", servers: { slack: s } })["slack-x"] as any

  // write-enabled (the fork's default): no --transport flag, no write env
  const write = fork({ keychain: "K", package: "@nrjdalal/slack-mcp-server", addMessageTool: true })
  expect(write.args).toEqual(["-y", "@nrjdalal/slack-mcp-server@latest"])
  expect(write.args).not.toContain("--transport")
  expect(write.env.SLACK_MCP_ALLOW_WRITE).toBeUndefined()
  expect(write.env.SLACK_MCP_ADD_MESSAGE_TOOL).toBeUndefined()

  // read-only: opt out of write with SLACK_MCP_ALLOW_WRITE=false
  const ro = fork({ keychain: "K", package: "@nrjdalal/slack-mcp-server" })
  expect(ro.env.SLACK_MCP_ALLOW_WRITE).toBe("false")

  // korotovsky (explicit, non-default) keeps --transport stdio and the add-message-tool env
  const koro = fork({ keychain: "K", package: "slack-mcp-server", addMessageTool: true })
  expect(koro.args).toContain("--transport")
  expect(koro.env.SLACK_MCP_ADD_MESSAGE_TOOL).toBe("true")
  expect(koro.env.SLACK_MCP_ALLOW_WRITE).toBeUndefined()
})

test("validateConfig rejects an unknown slack package", () => {
  expect(() =>
    validateConfig({
      version: CONFIG_VERSION,
      workspaces: [
        {
          name: "ok",
          path: "~/x",
          servers: { slack: { keychain: "K", package: "evil-pkg" } } as never,
        },
      ],
    }),
  ).toThrow(/Slack package .* is invalid/)
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

test("pathConflict flags a different-named workspace already at a path", () => {
  const cfg: Config = {
    version: 1,
    workspaces: [{ name: "foo", path: "/tmp/acme", servers: {} }],
  }
  expect(pathConflict(cfg, "/tmp/acme", "foo")).toBeUndefined() // same label = a normal update
  expect(pathConflict(cfg, "/tmp/acme", "bar")?.name).toBe("foo") // different name collides
  expect(pathConflict(cfg, "/tmp/free", "bar")).toBeUndefined() // free path
})

test("gitGlobalHint surfaces the global value, or notes there is none", () => {
  expect(gitGlobalHint("me@acme.org")).toBe("global: me@acme.org")
  expect(gitGlobalHint(null)).toBe("no global set")
})

test("home() honors process.env.HOME so apply writes stay in the sandbox", () => {
  // Regression: os.homedir() ignores a runtime process.env.HOME change (under
  // Bun especially), so without honoring $HOME the zshrc/gitconfig writes
  // escaped the test sandbox and appended dead source lines to the real ~/.zshrc.
  const prev = process.env.HOME
  try {
    process.env.HOME = "/tmp/inscope-home-probe"
    expect(home()).toBe("/tmp/inscope-home-probe")
    expect(zshrcPath()).toBe("/tmp/inscope-home-probe/.zshrc")
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
  }
})

test("relocating a workspace to a new path prunes the old path's managed block", () => {
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  const sb = tmpDir()
  process.env.HOME = sb
  process.env.XDG_CONFIG_HOME = path.join(sb, ".config")
  try {
    const a = path.join(sb, "a")
    const b = path.join(sb, "b")
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })
    const keys = (dir: string) =>
      Object.keys(JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers)

    persist({ name: "foo", path: a, servers: { github: true } })
    expect(keys(a)).toContain("github-foo")

    persist({ name: "foo", path: b, servers: { github: true } }) // relocate a -> b
    expect(keys(b)).toContain("github-foo")
    expect(keys(a)).not.toContain("github-foo") // old managed block pruned
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
  }
})

test("a nested workspace resolves to the child, not the enclosing parent", () => {
  // Parent name sorts first, so a name-sorted `case` would shadow the child.
  const cfg: Config = {
    version: 1,
    workspaces: [
      { name: "aaa-parent", path: "~/work", gh: "parent", servers: {} },
      { name: "zzz-child", path: "~/work/client", gh: "child", servers: {} },
    ],
  }
  // hook: the more specific child arm is emitted before the parent it sits under
  const hook = renderHook(cfg)
  expect(hook.indexOf(`"$HOME/work/client/"*`)).toBeLessThan(hook.indexOf(`"$HOME/work/"*`))

  // doctor's resolver agrees (longest-prefix-wins), so it would not bless a
  // mis-resolution. Parent order in the config array must not matter.
  expect(currentWorkspace(cfg, "/tmp")).toBeUndefined()
  const abs = {
    ...cfg,
    workspaces: cfg.workspaces.map((w) => ({ ...w, path: `/srv/${w.path.slice(2)}` })),
  }
  expect(currentWorkspace(abs, "/srv/work/client/src")?.name).toBe("zzz-child")
  expect(currentWorkspace(abs, "/srv/work/other")?.name).toBe("aaa-parent")
})

test("git email/name reject newlines (gitconfig injection guard)", () => {
  expect(gitValueError("neeraj@acme.com")).toBeNull()
  expect(gitValueError("Neeraj Dalal")).toBeNull()
  expect(gitValueError("a@b.com\n[core]\n\tsshCommand = touch /tmp/x")).toBe(
    "must not contain a newline",
  )
  expect(gitValueError("Name\rmore")).toBe("must not contain a newline")

  const inject = (git: { email?: string; name?: string }): Config => ({
    version: 1,
    workspaces: [{ name: "w", path: "~/w", git, servers: {} }],
  })
  expect(() => validateConfig(inject({ email: "a@b.com\n[core]" }))).toThrow(
    /git email [\s\S]*must not contain a newline/,
  )
  expect(() => validateConfig(inject({ name: "Bad\nName" }))).toThrow(
    /git name [\s\S]*must not contain a newline/,
  )
})

test("validateConfig refuses a config newer than it understands, tolerates older", () => {
  expect(() => validateConfig({ version: CONFIG_VERSION, workspaces: [] })).not.toThrow()
  // missing/older version is fine (a future migration owns the upgrade)
  expect(() => validateConfig({ workspaces: [] } as unknown as Config)).not.toThrow()
  expect(() => validateConfig({ version: CONFIG_VERSION + 1, workspaces: [] })).toThrow(
    /newer than this inscope supports/,
  )
})

test("loadConfig surfaces a too-new version on its own, not under 'fix it and re-run'", () => {
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = tmpDir()
  try {
    const file = configPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: CONFIG_VERSION + 1, workspaces: [] }))
    expect(() => loadConfig()).toThrow(/newer than this inscope supports/)
    let message = ""
    try {
      loadConfig()
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toContain("Fix it in")
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  }
})

test("saveConfig validates at the write boundary (nothing written on reject)", () => {
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = tmpDir()
  try {
    const bad: Config = {
      version: 1,
      workspaces: [
        {
          name: "w",
          path: "~/w",
          git: { email: "a@b.com\n[core]\n\tsshCommand = x" },
          servers: {},
        },
      ],
    }
    expect(() => saveConfig(bad)).toThrow(/must not contain a newline/)
    expect(fs.existsSync(configPath())).toBe(false)

    const good: Config = {
      version: 1,
      workspaces: [{ name: "w", path: "~/w", git: { email: "a@b.com" }, servers: {} }],
    }
    saveConfig(good)
    expect(fs.existsSync(configPath())).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  }
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
  // a trailing backslash escapes the closing quote in `gh_user="<v>"`, producing
  // an unsourceable hook, so it must be rejected too
  expect(hookValueError("foo\\")).not.toBeNull()
  expect(hookValueError("a\\b")).not.toBeNull()
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

test("validateConfig rejects a non-boolean isolate, accepts a boolean", () => {
  expect(() =>
    validateConfig({
      version: 1,
      workspaces: [{ name: "ok", path: "~/x", isolate: "yes" as unknown as boolean, servers: {} }],
    }),
  ).toThrow(/isolate must be a boolean/)
  expect(() =>
    validateConfig({
      version: 1,
      workspaces: [{ name: "ok", path: "~/x", isolate: true, servers: {} }],
    }),
  ).not.toThrow()
})

test("validateConfig guards the top-level bypass knob", () => {
  const workspaces = [{ name: "ok", path: "~/x", servers: {} }]
  expect(() => validateConfig({ version: 1, bypass: true, workspaces })).not.toThrow()
  expect(() => validateConfig({ version: 1, workspaces })).not.toThrow()
  expect(() =>
    validateConfig({ version: 1, bypass: "yes" as unknown as boolean, workspaces }),
  ).toThrow(/bypass must be a boolean/)
})

test("renderGitignore ignores .inscope once, idempotently, leaving an existing rule alone", () => {
  const once = renderGitignore("node_modules\n")
  expect(once).toContain("node_modules")
  expect(once).toContain(".inscope/")
  expect(once.match(/\.inscope\//g)).toHaveLength(1)
  // re-running is a no-op
  expect(renderGitignore(once)).toBe(once)
  // a fresh file has no leading blank line
  expect(renderGitignore("").startsWith("# inscope:")).toBe(true)
  // an already-ignored dir is left untouched across gitignore spellings:
  // bare, trailing slash, and the anchored /.inscope[/] forms
  expect(renderGitignore(".inscope\n")).toBe(".inscope\n")
  expect(renderGitignore("/.inscope/\n")).toBe("/.inscope/\n")
  expect(isInscopeIgnored("build/\n.inscope/\n")).toBe(true)
  expect(isInscopeIgnored("/.inscope/\n")).toBe(true)
  expect(isInscopeIgnored("/.inscope\n")).toBe(true)
  expect(isInscopeIgnored("build/\n")).toBe(false)
  // a sibling that merely starts with the name is not the entry
  expect(isInscopeIgnored(".inscope.bak\n")).toBe(false)
})

test("inscopeSignedIn: real content is signed in; empty/absent/noise/non-dir is not", () => {
  const dir = tmpDir()
  const inscope = path.join(dir, ".inscope")

  // absent dir -> not signed in (no throw)
  expect(inscopeSignedIn(inscope)).toBe(false)

  // empty dir -> not signed in
  fs.mkdirSync(inscope)
  expect(inscopeSignedIn(inscope)).toBe(false)

  // OS noise only (.DS_Store) does not count as a login
  fs.writeFileSync(path.join(inscope, ".DS_Store"), "")
  expect(inscopeSignedIn(inscope)).toBe(false)

  // a real Claude artifact -> signed in
  fs.writeFileSync(path.join(inscope, ".credentials.json"), "{}")
  expect(inscopeSignedIn(inscope)).toBe(true)

  // a path that is a file, not a dir -> not signed in (readdir would ENOTDIR)
  const asFile = path.join(tmpDir(), ".inscope")
  fs.writeFileSync(asFile, "oops")
  expect(inscopeSignedIn(asFile)).toBe(false)
})

test("applyIsolation scaffolds .inscope and gitignores it, only when isolate is on", () => {
  const dir = tmpDir()
  const ws = { name: "acme", path: dir, isolate: true, servers: {} }
  applyIsolation(ws)
  expect(fs.existsSync(inscopeDirPath(ws))).toBe(true)
  expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".inscope/")
  // idempotent: a second apply neither duplicates the rule nor errors
  applyIsolation(ws)
  expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").match(/\.inscope\//g)).toHaveLength(
    1,
  )

  // a non-isolated workspace is a no-op: no dir, no .gitignore
  const plain = tmpDir()
  applyIsolation({ name: "p", path: plain, servers: {} })
  expect(fs.existsSync(path.join(plain, ".inscope"))).toBe(false)
  expect(fs.existsSync(path.join(plain, ".gitignore"))).toBe(false)
})

test("mergeBypassSettings sets/clears only its own key, preserving the rest", () => {
  // on: adds defaultMode without disturbing other settings or other permission keys
  expect(mergeBypassSettings({ model: "opus", permissions: { allow: ["Bash"] } }, true)).toEqual({
    model: "opus",
    permissions: { allow: ["Bash"], defaultMode: "bypassPermissions" },
  })
  // off: removes inscope's mode, and drops a now-empty permissions object
  expect(mergeBypassSettings({ permissions: { defaultMode: "bypassPermissions" } }, false)).toEqual(
    {},
  )
  // off: leaves a mode the user set to something else alone
  expect(mergeBypassSettings({ permissions: { defaultMode: "acceptEdits" } }, false)).toEqual({
    permissions: { defaultMode: "acceptEdits" },
  })
  // on is idempotent
  const once = mergeBypassSettings({}, true)
  expect(mergeBypassSettings(once, true)).toEqual(once)
  // a malformed array `permissions` is treated as absent, not spread to numeric keys
  expect(mergeBypassSettings({ permissions: ["x"] as unknown as object }, true)).toEqual({
    permissions: { defaultMode: "bypassPermissions" },
  })
})

test("applyBypass writes an isolated login's settings.json, no-ops elsewhere", () => {
  const dir = tmpDir()
  const ws = { name: "acme", path: dir, isolate: true, servers: {} }
  fs.mkdirSync(inscopeDirPath(ws))
  // pre-existing settings are preserved when bypass is written
  fs.writeFileSync(inscopeSettingsPath(ws), JSON.stringify({ model: "opus" }) + "\n")

  applyBypass(ws, true)
  expect(JSON.parse(fs.readFileSync(inscopeSettingsPath(ws), "utf8"))).toEqual({
    model: "opus",
    permissions: { defaultMode: "bypassPermissions" },
  })
  expect(hasBypassSetting(ws)).toBe(true)

  // turning it off strips the key but keeps the rest
  applyBypass(ws, false)
  expect(JSON.parse(fs.readFileSync(inscopeSettingsPath(ws), "utf8"))).toEqual({ model: "opus" })
  expect(hasBypassSetting(ws)).toBe(false)

  // a non-isolated workspace never gets a settings.json
  const plain = { name: "p", path: tmpDir(), servers: {} }
  fs.mkdirSync(path.join(plain.path, ".inscope"))
  applyBypass(plain, true)
  expect(fs.existsSync(inscopeSettingsPath(plain))).toBe(false)

  // bypass off with no existing file creates nothing
  const fresh = { name: "f", path: tmpDir(), isolate: true, servers: {} }
  fs.mkdirSync(inscopeDirPath(fresh))
  applyBypass(fresh, false)
  expect(fs.existsSync(inscopeSettingsPath(fresh))).toBe(false)

  // a bypass-only file, turned off, is removed rather than left as `{}`
  const only = { name: "o", path: tmpDir(), isolate: true, servers: {} }
  fs.mkdirSync(inscopeDirPath(only))
  applyBypass(only, true)
  expect(fs.existsSync(inscopeSettingsPath(only))).toBe(true)
  applyBypass(only, false)
  expect(fs.existsSync(inscopeSettingsPath(only))).toBe(false)
})

test("runDoctor isolate checks: warn on empty/tracked, ok when signed in", () => {
  // fake git so `ls-files --error-unmatch .inscope` returns a chosen status:
  // 0 tracked, 1 untracked/ignored, 128 not-a-repo. isolateChecks is the only
  // check that shells out for a bare isolated workspace, so nothing else needs it.
  const gitRunner =
    (status: number): Runner =>
    (cmd, args) =>
      cmd === "git" && args.includes("ls-files")
        ? { status, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "" }

  const claudeChecks = (dir: string, gitStatus: number) =>
    runDoctor(
      { version: 1, workspaces: [{ name: "acme", path: dir, isolate: true, servers: {} }] },
      gitRunner(gitStatus),
    ).filter((c) => c.label === "[acme] claude")

  // empty .inscope + untracked -> one "sign in once" warning
  const empty = tmpDir()
  fs.mkdirSync(path.join(empty, ".inscope"))
  const emptyChecks = claudeChecks(empty, 1)
  expect(emptyChecks).toHaveLength(1)
  expect(emptyChecks[0].status).toBe("warn")
  expect(emptyChecks[0].detail).toContain("sign in")

  // real content + untracked -> one ok
  const signed = tmpDir()
  fs.mkdirSync(path.join(signed, ".inscope"))
  fs.writeFileSync(path.join(signed, ".inscope", ".credentials.json"), "{}")
  const okChecks = claudeChecks(signed, 1)
  expect(okChecks).toHaveLength(1)
  expect(okChecks[0].status).toBe("ok")
  expect(okChecks[0].detail).toContain("isolated login")

  // signed in + tracked by git (status 0) -> ok plus a "tracked by git" warn
  const trackedChecks = claudeChecks(signed, 0)
  expect(trackedChecks).toHaveLength(2)
  expect(
    trackedChecks.some((c) => c.status === "warn" && c.detail?.includes("tracked by git")),
  ).toBe(true)

  // not-a-repo (status 128) -> no tracked warn, just the ok
  expect(claudeChecks(signed, 128)).toHaveLength(1)
})

test("runDoctor flags bypass drift in both directions", () => {
  // git ls-files -> untracked (status 1), so no "tracked by git" warn interferes
  const run: Runner = () => ({ status: 1, stdout: "", stderr: "" })
  // a signed-in isolated login (so the "sign in" warn does not fire)
  const mk = () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, ".inscope"))
    fs.writeFileSync(path.join(dir, ".inscope", ".credentials.json"), "{}")
    return dir
  }
  const details = (dir: string, bypass: boolean) =>
    runDoctor(
      { version: 1, bypass, workspaces: [{ name: "acme", path: dir, isolate: true, servers: {} }] },
      run,
    )
      .filter((c) => c.label === "[acme] claude")
      .map((c) => c.detail ?? "")

  // config ON, login has no setting -> "not applied" warn
  expect(details(mk(), true).some((d) => d.includes("not applied to this login"))).toBe(true)

  // config OFF, login still carries bypass -> the dangerous reverse warn
  const off = mk()
  applyBypass({ name: "acme", path: off, isolate: true, servers: {} }, true)
  expect(details(off, false).some((d) => d.includes("still has it"))).toBe(true)

  // config ON and applied -> no bypass warn at all
  const ok = mk()
  applyBypass({ name: "acme", path: ok, isolate: true, servers: {} }, true)
  expect(details(ok, true).some((d) => d.includes("bypass"))).toBe(false)
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
          args: ["-y", "@nrjdalal/slack-mcp-server@latest"],
          env: {
            SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN}",
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

test("slackPackageFromArgs detects the package, ignoring the version suffix", () => {
  expect(slackPackageFromArgs(["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"])).toBe(
    "slack-mcp-server",
  )
  expect(slackPackageFromArgs(["-y", "@nrjdalal/slack-mcp-server@latest"])).toBe(
    "@nrjdalal/slack-mcp-server",
  )
  expect(slackPackageFromArgs(["-y", "@nrjdalal/slack-mcp-server"])).toBe(
    "@nrjdalal/slack-mcp-server",
  )
  expect(slackPackageFromArgs(["-y", "slack-mcp-server"])).toBe("slack-mcp-server")
  expect(slackPackageFromArgs(["-y", "some-other-mcp@1.0.0"])).toBeNull()
  // a sibling name that merely contains the package name is not the package
  expect(slackPackageFromArgs(["-y", "slack-mcp-server-fork@1.0.0"])).toBeNull()
  expect(slackPackageFromArgs(undefined)).toBeNull()
})

const writeSlackMcp = (dir: string, args: string[], env: Record<string, string> = {}) =>
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "slack-acme": {
          type: "stdio",
          command: "npx",
          args,
          env: { SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN}", ...env },
        },
      },
    }),
  )

test("adoptable back-syncs a hand-edited slack package, both ways, idempotently", () => {
  const dir = tmpDir()
  // hold write intent constant (read-only on both sides) to isolate the package adopt
  // on-disk korotovsky (non-default), config on the default -> adopt the pinned pkg into config
  writeSlackMcp(dir, ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"])
  const cfg: Config = {
    version: 1,
    workspaces: [{ name: "acme", path: dir, servers: { slack: { keychain: "K" } } }],
  }
  const { cfg: pinned, changes } = adoptable(cfg)
  expect(changes).toContain("acme: slack.package = slack-mcp-server")
  expect(pinned.workspaces[0].servers.slack).toEqual({
    keychain: "K",
    package: "slack-mcp-server",
  })
  expect(adoptable(pinned).changes).toHaveLength(0)

  // on-disk reverted to the default (@nrjdalal), config on the pinned pkg -> drop the redundant key
  writeSlackMcp(dir, ["-y", "@nrjdalal/slack-mcp-server@latest"], {
    SLACK_MCP_ALLOW_WRITE: "false",
  })
  const { cfg: reverted, changes: revertChanges } = adoptable(pinned)
  expect(revertChanges).toContain("acme: slack.package = @nrjdalal/slack-mcp-server")
  expect(reverted.workspaces[0].servers.slack).toEqual({ keychain: "K" })
  expect(adoptable(reverted).changes).toHaveLength(0)
})

test("adoptable back-syncs the fork's read-only/write toggle, both ways", () => {
  const dir = tmpDir()
  const forkArgs = ["-y", "@nrjdalal/slack-mcp-server@latest"]

  // config: fork, write-enabled. disk hand-edited to read-only (ALLOW_WRITE=false)
  writeSlackMcp(dir, forkArgs, { SLACK_MCP_ALLOW_WRITE: "false" })
  const cfg: Config = {
    version: 1,
    workspaces: [
      {
        name: "acme",
        path: dir,
        servers: {
          slack: { keychain: "K", package: "@nrjdalal/slack-mcp-server", addMessageTool: true },
        },
      },
    ],
  }
  const { cfg: ro, changes } = adoptable(cfg)
  expect(changes).toContain("acme: slack.addMessageTool = false")
  // read-only is the default, so the key is dropped
  expect(ro.workspaces[0].servers.slack).toEqual({
    keychain: "K",
    package: "@nrjdalal/slack-mcp-server",
  })
  expect(adoptable(ro).changes).toHaveLength(0)

  // disk hand-edited back to write (no ALLOW_WRITE, the fork's default) -> adopt true
  writeSlackMcp(dir, forkArgs)
  const { cfg: rw, changes: c2 } = adoptable(ro)
  expect(c2).toContain("acme: slack.addMessageTool = true")
  expect(rw.workspaces[0].servers.slack).toEqual({
    keychain: "K",
    package: "@nrjdalal/slack-mcp-server",
    addMessageTool: true,
  })
  expect(adoptable(rw).changes).toHaveLength(0)
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

// Run a block with HOME and XDG_CONFIG_HOME pointed at a throwaway sandbox, so a
// test can exercise the real on-disk apply paths without touching the dev box.
const withSandbox = (fn: (sb: string) => void) => {
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  const sb = tmpDir()
  process.env.HOME = sb
  process.env.XDG_CONFIG_HOME = path.join(sb, ".config")
  try {
    fn(sb)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
  }
}

test("applyAll is all-or-nothing: a malformed .mcp.json aborts before any write", () => {
  withSandbox((sb) => {
    const good = path.join(sb, "good")
    const bad = path.join(sb, "bad")
    fs.mkdirSync(good, { recursive: true })
    fs.mkdirSync(bad, { recursive: true })
    fs.writeFileSync(path.join(bad, ".mcp.json"), '{ "mcpServers": {')

    const cfg: Config = {
      version: 1,
      workspaces: [
        { name: "good", path: good, servers: { github: true } },
        { name: "bad", path: bad, servers: { github: true } },
      ],
    }
    expect(() => applyAll(cfg)).toThrow(/not valid JSON/)
    // pre-flight threw before any write: no hook, and the parseable workspace's
    // .mcp.json was never created (no half-applied state).
    expect(fs.existsSync(hookPath())).toBe(false)
    expect(fs.existsSync(path.join(good, ".mcp.json"))).toBe(false)
  })
})

test("applyAll scaffolds an isolated workspace and wires its wrapper into the hook", () => {
  withSandbox((sb) => {
    const proj = path.join(sb, "acme")
    fs.mkdirSync(proj, { recursive: true })
    const cfg: Config = {
      version: 1,
      workspaces: [{ name: "acme", path: proj, isolate: true, servers: { github: true } }],
    }
    applyAll(cfg)
    // the project-local config dir exists and is gitignored
    expect(fs.existsSync(path.join(proj, ".inscope"))).toBe(true)
    expect(fs.readFileSync(path.join(proj, ".gitignore"), "utf8")).toContain(".inscope/")
    // the generated hook carries the launch wrapper pointing at it (HOME=sb, so the
    // sandbox path renders as $HOME/acme)
    expect(fs.readFileSync(hookPath(), "utf8")).toContain(`dir="$HOME/acme/.inscope"`)
  })
})

test("writeFileAtomic writes through a symlink, preserving the link", () => {
  const dir = tmpDir()
  const real = path.join(dir, "real.txt")
  const link = path.join(dir, "link.txt")
  fs.writeFileSync(real, "old\n")
  fs.symlinkSync(real, link)

  writeFileAtomic(link, "new\n")

  // a dotfile manager's symlink survives (we replaced the target, not the link)
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  expect(fs.readFileSync(real, "utf8")).toBe("new\n")
  expect(fs.readFileSync(link, "utf8")).toBe("new\n")
})

test("writeFileAtomic preserves the target file's mode", () => {
  const dir = tmpDir()
  const file = path.join(dir, "secret")
  fs.writeFileSync(file, "old\n")
  fs.chmodSync(file, 0o600)

  writeFileAtomic(file, "new\n")

  // rename swaps the inode, so without restoring the mode a 0600 file would
  // silently widen to the umask default.
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(file, "utf8")).toBe("new\n")
})

test("loadConfig gives a friendly, path-hinted error on malformed JSON", () => {
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = tmpDir()
  try {
    const file = configPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ "version": 1, "workspaces": [')
    let message = ""
    try {
      loadConfig()
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("is not valid JSON")
    expect(message).not.toMatch(/Unexpected|EOF|JSON Parse/)
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  }
})

test("removeBlock keeps surrounding content and collapses the gap it leaves", () => {
  const file = path.join(tmpDir(), ".zshrc")
  upsertBlock(file, "x", "managed line")
  fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\nexport AFTER=1\n")
  expect(readBlock(file, "x")).toBe("managed line")

  removeBlock(file, "x")
  const out = fs.readFileSync(file, "utf8")
  expect(readBlock(file, "x")).toBeNull()
  expect(out).toContain("export AFTER=1")
  expect(out).not.toMatch(/\n{3,}/)
})

// zsh availability: the hook is the security-critical artifact and the whole
// safety story rests on it staying well-formed zsh after the name/path/keychain
// quoting. `zsh -n` parses without executing, so a quoting regression fails here
// directly. Skipped where zsh is absent (some dev boxes); CI's macos-latest has it.
const hasZsh = (() => {
  try {
    return spawnSync("zsh", ["--version"]).status === 0
  } catch {
    return false
  }
})()

test.skipIf(!hasZsh)("the rendered hook parses as valid zsh (zsh -n)", () => {
  // every pathPattern branch and idArm shape, plus a path with spaces and a
  // dotted/dashed/underscored name, mirroring the golden coverage config. Two
  // workspaces are isolated so the exported CLAUDE_CONFIG_DIR pin (a home-root and
  // a spaced-path .inscope arm) is parse-checked too.
  const cfg: Config = {
    version: 1,
    workspaces: [
      { name: "home", path: "~", gh: "acct", isolate: true, servers: { github: true } },
      { name: "opt", path: "/opt/work", gh: "acct", servers: { github: true } },
      {
        name: "my-project-work",
        path: "~/My Project (work)",
        gh: "acme-org",
        isolate: true,
        servers: { github: true, slack: { keychain: "SLACK_MCP_XOXP_TOKEN_MYPROJECT" } },
      },
      { name: "slackonly", path: "~/slackonly", servers: { slack: { keychain: "K" } } },
      { name: "web.app-2_x", path: "~/webapp", gh: "acct", servers: { github: true } },
    ],
  }
  const file = path.join(tmpDir(), "inscope.zsh")
  fs.writeFileSync(file, renderHook(cfg))
  const res = spawnSync("zsh", ["-n", file], { encoding: "utf8" })
  expect(res.stderr).toBe("")
  expect(res.status).toBe(0)
})

test("mcpTarget preview is byte-identical to what applyMcp writes", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".mcp.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: { custom: { type: "http", url: "x" }, "github-acme": { url: "STALE" } },
    }),
  )
  const ws = { name: "acme", path: dir, servers: { github: true, linear: true } }

  // the diff preview and the apply share one merge, so the preview must equal
  // the exact bytes apply writes; that is the whole point of sharing it.
  const preview = mcpTarget(ws)
  applyMcp(ws)
  expect(fs.readFileSync(file, "utf8")).toBe(preview)
})

test("applyGitconfig prunes a per-workspace gitconfig when identity is dropped", () => {
  withSandbox(() => {
    const withId: Config = {
      version: 1,
      workspaces: [{ name: "acme", path: "~/acme", git: { email: "a@b.com" }, servers: {} }],
    }
    applyGitconfig(withId)
    const file = perWorkspaceGitconfigPath("acme")
    expect(fs.existsSync(file)).toBe(true)

    const noId: Config = {
      version: 1,
      workspaces: [{ name: "acme", path: "~/acme", servers: {} }],
    }
    applyGitconfig(noId)
    expect(fs.existsSync(file)).toBe(false) // stale file pruned, not left orphaned
  })
})
