import { expect, test } from "bun:test"

import { renderZshrcSource } from "@/apply"
import type { Config, Workspace } from "@/config"
import { renderGitInclude, renderPerWorkspaceGitconfig } from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { renderMcp, SERVER_TYPES } from "@/generators/mcp"
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
    hubspot: true,
    intercom: true,
    linear: true,
    monday: true,
    notion: true,
    plane: true,
    sentry: true,
    slack: { keychain: "SLACK_MCP_XOXP_TOKEN_ACME", addMessageTool: true },
    stripe: true,
    vercel: true,
    webflow: true,
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

// Claude Code config-dir scoping. CLAUDE_CONFIG_DIR is resolved in the launch
// wrapper from $PWD (the token resolver above is untouched). Exercises every arm
// shape: a named profile (~/.claude-acme), the reserved `claude` name (base
// ~/.claude), and a workspace with no profile (no wrapper arm; it keeps the base
// like any unmapped dir). Locks the wrapper's $PWD case and the per-launch
// CLAUDE_CONFIG_DIR.
test("golden: chpwd hook with Claude config-dir profiles", () => {
  expect(
    renderHook({
      version: 1,
      workspaces: [
        { name: "acme", path: "~/acme", gh: "acme-bot", claude: "acme", servers: { github: true } },
        { name: "oss", path: "~/oss", claude: "claude", servers: { github: true } },
        { name: "side", path: "~/side", gh: "nrjdalal", servers: { github: true } },
      ],
    }),
  ).toMatchSnapshot()
})

// A single profiled workspace: the wrapper carries one $PWD arm; the other
// workspace and every unmapped dir keep the base ~/.claude.
test("golden: chpwd hook with a single Claude override and no default", () => {
  expect(
    renderHook({
      version: 1,
      workspaces: [
        { name: "acme", path: "~/acme", claude: "acme", servers: { github: true } },
        { name: "personal", path: "~/personal", gh: "nrjdalal", servers: { github: true } },
      ],
    }),
  ).toMatchSnapshot()
})

// wrapClaude `true` plus a profile: the wrapper resolves the config dir from
// $PWD, runs `claude update` first, then launches --dangerously-skip-permissions
// carrying CLAUDE_CONFIG_DIR for that launch.
test("golden: chpwd hook with wrapClaude enabled (both flags)", () => {
  expect(
    renderHook({
      version: 1,
      wrapClaude: true,
      workspaces: [{ name: "acme", path: "~/acme", claude: "acme", servers: { github: true } }],
    }),
  ).toMatchSnapshot()
})

// Object form toggles flags individually: skip-permissions only, no auto-update.
// No workspace sets a profile, so the wrapper stays a one-liner with no $PWD case
// (wrapClaude is independent of profiles).
test("golden: chpwd hook with wrapClaude object, skip-permissions only", () => {
  expect(
    renderHook({
      version: 1,
      wrapClaude: { dangerouslySkipPermissions: true },
      workspaces: [{ name: "acme", path: "~/acme", gh: "acme", servers: { github: true } }],
    }),
  ).toMatchSnapshot()
})

// --- git config ---

test("golden: gitconfig includeIf block", () => {
  expect(renderGitInclude(twoWorkspaces)).toMatchSnapshot()
})

// gitdir patterns for home root, non-home absolute, and a path with spaces, the
// no-git-identity workspace ("nogit") filtered out, and a deliberately
// non-alphabetical input order (opt before home) so the snapshot locks that
// renderGitInclude preserves config order rather than sorting it (unlike
// renderHook, which name-sorts). A regression that introduced a sort here would
// change this snapshot and fail.
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
