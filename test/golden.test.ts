import { expect, test } from "bun:test"

import { renderZshrcSource } from "@/apply"
import type { Config, Workspace } from "@/config"
import { renderGitInclude, renderPerWorkspaceGitconfig } from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { renderMcp, SERVER_TYPES } from "@/generators/mcp"
import { renderLaunchAgent, renderProxyConfig } from "@/proxy"
import { renderStatus, type StatusSnapshot } from "@/status"
import { renderUsage, type UsageRow } from "@/usage"
import { slackKeychainFor } from "~/bin/commands/_workspace"

// Golden suite: lock the EXACT generated artifacts (chpwd hook, .mcp.json, git
// includes, .zshrc source line) so any drift is caught on review instead of
// shipped. These artifacts are the contract the tool lives or dies by. The
// generators emit literal `$HOME` / `~` tokens, so output is independent of the
// real home dir as long as XDG_CONFIG_HOME is unset.
//
// To intentionally change an artifact: run `bun test --update-snapshots` and
// review the diff in test/__snapshots__/golden.test.ts.snap before committing.
delete process.env.XDG_CONFIG_HOME

const allServers: Workspace = {
  name: "acme",
  path: "~/acme",
  gh: "neeraj-acme-org",
  git: { email: "neeraj@acme.org", name: "Neeraj Dalal" },
  servers: {
    github: true,
    atlassian: true,
    canva: true,
    clickup: true,
    datadog: { site: "datadoghq.eu" },
    hubspot: true,
    intercom: true,
    linear: true,
    monday: true,
    notion: true,
    nylas: { keychain: "NYLAS_API_KEY_ACME", region: "eu" },
    plane: true,
    posthog: true,
    sentry: true,
    slack: { keychain: "SLACK_MCP_XOXP_TOKEN_ACME", addMessageTool: true },
    stripe: true,
    vercel: true,
    webflow: true,
    xquik: true,
  },
}

const twoWorkspaces: Config = {
  version: 1,
  workspaces: [
    {
      name: "acme",
      path: "~/acme",
      gh: "neeraj-acme-org",
      git: { email: "neeraj@acme.org" },
      servers: {
        github: true,
        linear: true,
        slack: { keychain: "SLACK_MCP_XOXP_TOKEN_ACME" },
      },
    },
    {
      name: "personal",
      path: "~/personal",
      gh: "nrjdalal",
      git: { email: "hello@nrjdalal.com" },
      servers: { github: true },
    },
  ],
}

// --- .mcp.json ---

test("golden: .mcp.json with every server enabled", () => {
  expect(renderMcp(allServers)).toMatchSnapshot()
})

test("golden: .mcp.json for a github-only workspace", () => {
  expect(
    renderMcp({
      name: "personal",
      path: "~/personal",
      gh: "nrjdalal",
      servers: { github: true },
    }),
  ).toMatchSnapshot()
})

test("golden: Slack server, read-only vs post-enabled", () => {
  const base = { name: "acme", path: "~/acme" }
  expect(renderMcp({ ...base, servers: { slack: { keychain: "K" } } })).toMatchSnapshot("read-only")
  expect(
    renderMcp({
      ...base,
      servers: { slack: { keychain: "K", addMessageTool: true } },
    }),
  ).toMatchSnapshot("post-enabled")
})

test("golden: Slack server on the @nrjdalal package (kept latest)", () => {
  // write-enabled (addMessageTool): the fork's default, so no --transport flag and
  // no write env, just the token.
  expect(
    renderMcp({
      name: "acme",
      path: "~/acme",
      servers: {
        slack: { keychain: "K", package: "@nrjdalal/slack-mcp-server", addMessageTool: true },
      },
    }),
  ).toMatchSnapshot()
})

test("golden: @nrjdalal Slack fork read-only sets SLACK_MCP_ALLOW_WRITE=false", () => {
  expect(
    renderMcp({
      name: "acme",
      path: "~/acme",
      servers: { slack: { keychain: "K", package: "@nrjdalal/slack-mcp-server" } },
    }),
  ).toMatchSnapshot()
})

test("golden: an http server with a custom url override", () => {
  expect(
    renderMcp({
      name: "acme",
      path: "~/acme",
      servers: { linear: { url: "https://linear.internal/mcp" } },
    }),
  ).toMatchSnapshot()
})

test("golden: .mcp.json for a workspace with no servers", () => {
  expect(renderMcp({ name: "none", path: "~/none", servers: {} })).toMatchSnapshot()
})

// --- chpwd hook ---

test("golden: chpwd hook for two workspaces", () => {
  expect(renderHook(twoWorkspaces)).toMatchSnapshot()
})

test("golden: chpwd hook with no workspaces", () => {
  expect(renderHook({ version: 1, workspaces: [] })).toMatchSnapshot()
})

test("golden: chpwd hook arm for a workspace with neither gh nor slack", () => {
  expect(
    renderHook({
      version: 1,
      workspaces: [
        {
          name: "docs",
          path: "~/docs",
          git: { email: "me@x.dev" },
          servers: {},
        },
      ],
    }),
  ).toMatchSnapshot()
})

// Exercises every pathPattern branch (home root, non-home absolute, ~/sub,
// path with spaces) and every idArm shape (gh+slack, gh-only, slack-only) in a
// single artifact, plus a dotted/dashed/underscored name as a case label. Names
// are slugs, so they are interpolated unquoted as the case pattern; paths and
// values are double-quoted. This locks the output the name/path/keychain
// hardening produces.
//
// NOTE: this synthetic config also locks the nested-path resolution order.
// "home" maps to "$HOME/"* and would shadow ~/slackonly and ~/webapp if the
// arms were name-sorted, so the dir arms are emitted most-specific-first
// (longest path wins): ~/My Project (work), ~/slackonly, /opt/work, ~/webapp,
// then ~. The id arms below stay name-sorted (they key on the exact $ws).
test("golden: chpwd hook covers tricky paths and every arm shape", () => {
  expect(
    renderHook({
      version: 1,
      workspaces: [
        { name: "home", path: "~", gh: "acct", servers: { github: true } },
        { name: "opt", path: "/opt/work", gh: "acct", servers: { github: true } },
        {
          name: "my-project-work",
          path: "~/My Project (work)",
          gh: "acme-org",
          servers: {
            github: true,
            slack: { keychain: "SLACK_MCP_XOXP_TOKEN_MYPROJECT" },
          },
        },
        {
          name: "slackonly",
          path: "~/slackonly",
          servers: { slack: { keychain: "K" } },
        },
        { name: "web.app-2_x", path: "~/webapp", gh: "acct", servers: { github: true } },
      ],
    }),
  ).toMatchSnapshot()
})

// Project-local Claude isolation: the chpwd hook gains a CLAUDE_CONFIG_DIR pin,
// resolved from $PWD to each isolated workspace's own `<path>/.inscope` (base
// ~/.claude everywhere else) and EXPORTED so any launcher inherits it. Arms are
// most-specific-first and cover a ~/sub path, a spaced path, and a non-home absolute
// path. A non-isolated workspace (personal) contributes no arm.
test("golden: chpwd hook with isolated workspaces (exported CLAUDE_CONFIG_DIR)", () => {
  expect(
    renderHook({
      version: 1,
      workspaces: [
        { name: "acme", path: "~/acme", gh: "acct", isolate: true, servers: { github: true } },
        { name: "client", path: "~/My Client (x)", isolate: true, servers: { github: true } },
        { name: "srv", path: "/opt/srv", isolate: true, servers: { github: true } },
        { name: "personal", path: "~/personal", gh: "nrjdalal", servers: { github: true } },
      ],
    }),
  ).toMatchSnapshot()
})

// A non-isolated workspace nested under an isolated one: the CCD pin must emit a
// no-op shadow arm for the child BEFORE the parent's arm, so the child keeps the
// base login. Pinned here so the shadow-arm shape cannot silently regress.
test("golden: exported CLAUDE_CONFIG_DIR shadows a nested non-isolated workspace", () => {
  expect(
    renderHook({
      version: 1,
      workspaces: [
        { name: "acme", path: "~/acme", isolate: true, servers: { github: true } },
        { name: "sub", path: "~/acme/sub", gh: "nrjdalal", servers: { github: true } },
      ],
    }),
  ).toMatchSnapshot()
})

// --- git config ---

test("golden: gitconfig includeIf block", () => {
  expect(renderGitInclude(twoWorkspaces)).toMatchSnapshot()
})

// gitdir patterns for home root, non-home absolute, and a path with spaces, the
// no-git-identity workspace ("nogit") filtered out. The blocks come out
// least-specific-first (the home root first), since git lets the last matching
// includeIf win and a nested workspace must override its parent.
test("golden: includeIf for tricky paths, skipping a no-git workspace", () => {
  expect(
    renderGitInclude({
      version: 1,
      workspaces: [
        { name: "opt", path: "/opt/work", git: { email: "o@x.dev" }, servers: {} },
        { name: "home", path: "~", git: { email: "h@x.dev" }, servers: {} },
        {
          name: "spaced",
          path: "~/My Project (work)",
          git: { email: "s@x.dev" },
          servers: {},
        },
        { name: "nogit", path: "~/nogit", servers: {} },
      ],
    }),
  ).toMatchSnapshot()
})

// A nested pair whose names sort the wrong way ("acme" < "work"): the parent's
// block must still come first so the nested workspace's identity wins in git.
test("golden: includeIf puts a nested workspace after its parent", () => {
  expect(
    renderGitInclude({
      version: 1,
      workspaces: [
        { name: "acme", path: "~/work/acme", git: { email: "a@acme.dev" }, servers: {} },
        { name: "personal", path: "~", git: { email: "me@home.dev" }, servers: {} },
        { name: "work", path: "~/work", git: { email: "w@corp.dev" }, servers: {} },
      ],
    }),
  ).toMatchSnapshot()
})

test("golden: includeIf is empty when no workspace has a git identity", () => {
  expect(
    renderGitInclude({
      version: 1,
      workspaces: [{ name: "x", path: "~/x", servers: {} }],
    }),
  ).toMatchSnapshot()
})

test("golden: per-workspace gitconfig", () => {
  const base = { name: "a", path: "~/a", servers: {} }
  expect(
    renderPerWorkspaceGitconfig({
      ...base,
      git: { email: "e@x.dev", name: "E" },
    }),
  ).toMatchSnapshot("email and name")
  expect(renderPerWorkspaceGitconfig({ ...base, git: { email: "e@x.dev" } })).toMatchSnapshot(
    "email only",
  )
  expect(renderPerWorkspaceGitconfig({ ...base, git: { name: "E" } })).toMatchSnapshot("name only")
  // defensive branch: neither field set (unreachable via applyGitconfig, which
  // gates on hasGitIdentity, but the function still renders a bare [user])
  expect(renderPerWorkspaceGitconfig({ ...base, git: {} })).toMatchSnapshot("neither")
})

// --- .zshrc source line ---

test("golden: .zshrc source line, fresh file and appended", () => {
  expect(renderZshrcSource("")).toMatchSnapshot("fresh")
  expect(renderZshrcSource("export FOO=1\n")).toMatchSnapshot("appended")
})

// --- server registry ---

test("golden: SERVER_TYPES registry order is locked", () => {
  expect([...SERVER_TYPES]).toMatchSnapshot()
})

test("golden: slack keychain naming for tricky labels", () => {
  expect({
    acme: slackKeychainFor("acme"),
    "brand-new": slackKeychainFor("brand-new"),
    "a.b c": slackKeychainFor("a.b c"),
    "Weird Name!": slackKeychainFor("Weird Name!"),
  }).toMatchSnapshot()
})

// --- inscope status card ---

// Locks the identity card `inscope status` prints (plain, painters default to
// no-ops), across the branches that shape it: an isolated signed-in workspace,
// a shared login, outside any workspace, and an isolated dir not yet signed in.
test("golden: status card, isolated signed-in workspace", () => {
  const snap: StatusSnapshot = {
    workspace: "acme",
    path: "~/acme",
    claude: {
      isolated: true,
      configDir: "~/acme/.inscope",
      signedIn: true,
      email: "you@acme.org",
      subscription: "team",
      org: "Acme Inc",
    },
    github: { account: "neeraj-acme-org", token: true },
    git: { email: "you@acme.org", source: "workspace" },
    servers: ["github", "linear", "slack"],
    skills: ["inscope", "readme-audit"],
  }
  expect(renderStatus(snap)).toMatchSnapshot()
})

test("golden: status card, shared login workspace", () => {
  const snap: StatusSnapshot = {
    workspace: "personal",
    path: "~/personal",
    claude: {
      isolated: false,
      configDir: "~/.claude",
      signedIn: true,
      email: "you@personal.com",
      subscription: "max",
    },
    github: { account: "nrjdalal", token: true },
    git: { email: "you@personal.com", source: "global" },
    servers: ["github"],
    skills: ["inscope"],
  }
  expect(renderStatus(snap)).toMatchSnapshot()
})

test("golden: status card, outside any workspace", () => {
  const snap: StatusSnapshot = {
    workspace: null,
    path: "~/scratch",
    claude: {
      isolated: false,
      configDir: "~/.claude",
      signedIn: true,
      email: "you@personal.com",
      subscription: "max",
    },
    github: null,
    git: { email: "you@personal.com", source: "global" },
    servers: [],
    skills: [],
  }
  expect(renderStatus(snap)).toMatchSnapshot()
})

test("golden: status card, isolated login not signed in", () => {
  const snap: StatusSnapshot = {
    workspace: "acme",
    path: "~/acme",
    claude: { isolated: true, configDir: "~/acme/.inscope", signedIn: false },
    github: { account: "neeraj-acme-org", token: false },
    git: { email: null, source: "global" },
    servers: ["github"],
    skills: ["inscope"],
  }
  expect(renderStatus(snap)).toMatchSnapshot()
})

// Accounts: a workspace on a named account exports that account's dir (rendered from
// the same absolute path `inscope login` signs in with), an isolated one keeps its own
// `.inscope`, a nested non-dedicated one keeps the base, and the base capture treats an
// inherited account login as never-the-base.
const withAccounts: Config = {
  version: 1,
  accounts: [{ name: "alt", email: "alt@x.dev" }, { name: "work" }],
  workspaces: [
    { name: "client", path: "~/client", servers: {}, isolate: true },
    { name: "side", path: "~/side", servers: {}, account: "alt" },
    { name: "side-notes", path: "~/side/notes", servers: {} },
    { name: "team", path: "~/team", servers: {}, account: "work" },
  ],
}

test("golden: hook with accounts", () => {
  expect(renderHook(withAccounts)).toMatchSnapshot()
})

test("golden: hook with accounts but no workspace on one yet", () => {
  expect(
    renderHook({
      version: 1,
      accounts: [{ name: "alt" }],
      workspaces: [{ name: "p", path: "~/p", servers: {} }],
    }),
  ).toMatchSnapshot()
})

test("golden: status on an account", () => {
  const snap: StatusSnapshot = {
    workspace: "side",
    path: "~/side",
    claude: {
      isolated: false,
      account: "alt",
      configDir: "~/.config/inscope/accounts/alt",
      signedIn: true,
      email: "alt@x.dev",
      subscription: "max",
    },
    github: null,
    git: { email: "neeraj@x.dev", source: "global" },
    servers: ["github"],
    skills: [],
  }
  expect(renderStatus(snap)).toMatchSnapshot()
})

test("golden: usage table", () => {
  const now = Date.parse("2026-10-10T12:00:00Z")
  const rows: UsageRow[] = [
    {
      label: "base",
      kind: "base",
      dir: "/h/.claude",
      usedBy: ["personal"],
      email: "me@x.dev",
      plan: "max 20x",
      state: "ok",
      fiveHour: { percent: 3.4, resetsAt: "2026-10-10T14:05:00Z" },
      week: { percent: 99, resetsAt: "2026-10-11T17:00:00Z" },
    },
    {
      label: "alt",
      kind: "account",
      dir: "/h/.config/inscope/accounts/alt",
      usedBy: ["side", "team"],
      email: "alt@x.dev",
      plan: "max 5x",
      state: "ok",
      fiveHour: { percent: 0, resetsAt: null },
      week: { percent: 72, resetsAt: "2026-10-15T09:00:00Z" },
    },
    {
      label: "old",
      kind: "account",
      dir: "/h/a/old",
      usedBy: [],
      email: "old@x.dev",
      plan: "pro",
      state: "expired",
    },
    { label: "gone", kind: "account", dir: "/h/a/gone", usedBy: [], state: "signed-out" },
    {
      label: "fresh",
      kind: "account",
      dir: "/h/a/fresh",
      usedBy: [],
      email: "fresh@x.dev",
      plan: "max 20x",
      state: "ok",
      fiveHour: { percent: null, resetsAt: "2026-10-10T13:00:00Z" },
      week: { percent: 0, resetsAt: null },
    },
    {
      label: "client",
      kind: "isolated",
      dir: "/h/client/.inscope",
      usedBy: ["client"],
      email: "c@client.com",
      plan: "team",
      state: "error",
      detail: "usage endpoint returned 500",
    },
  ]
  expect(renderUsage(rows, now)).toMatchSnapshot()
})

test("golden: status card, isolated login behind a gateway", () => {
  const snap: StatusSnapshot = {
    workspace: "acme",
    path: "~/acme",
    claude: {
      isolated: true,
      configDir: "~/acme/.inscope",
      signedIn: true,
      gateway: "127.0.0.1:8317",
    },
    github: { account: "neeraj-acme-org", token: true },
    git: { email: "neeraj@acme.org", source: "workspace" },
    servers: ["github"],
    skills: ["inscope"],
  }
  expect(renderStatus(snap)).toMatchSnapshot()
})

test("golden: proxy config", () => {
  expect(
    renderProxyConfig({
      port: 8317,
      key: "inscope-0123abcd",
      authDir: "/h/.config/inscope/proxy/auth",
    }),
  ).toMatchSnapshot()
})

test("golden: proxy launchd agent", () => {
  expect(
    renderLaunchAgent({
      bin: "/h/.config/inscope/proxy/bin/8.0.23/cli-proxy-api",
      config: "/h/.config/inscope/proxy/config.yaml",
      log: "/h/.config/inscope/proxy/proxy & log.log",
    }),
  ).toMatchSnapshot()
})
