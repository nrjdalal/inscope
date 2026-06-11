import { renderZshrcSource } from "@/apply"
import type { Config, Workspace } from "@/config"
import {
  renderGitInclude,
  renderPerWorkspaceGitconfig,
} from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { renderMcp, SERVER_TYPES } from "@/generators/mcp"
import { slackKeychainFor } from "~/bin/commands/_workspace"
import { expect, test } from "bun:test"

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
  expect(
    renderMcp({ ...base, servers: { slack: { keychain: "K" } } }),
  ).toMatchSnapshot("read-only")
  expect(
    renderMcp({
      ...base,
      servers: { slack: { keychain: "K", addMessageTool: true } },
    }),
  ).toMatchSnapshot("post-enabled")
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

// --- git config ---

test("golden: gitconfig includeIf block", () => {
  expect(renderGitInclude(twoWorkspaces)).toMatchSnapshot()
})

test("golden: per-workspace gitconfig", () => {
  const base = { name: "a", path: "~/a", servers: {} }
  expect(
    renderPerWorkspaceGitconfig({
      ...base,
      git: { email: "e@x.dev", name: "E" },
    }),
  ).toMatchSnapshot("email and name")
  expect(
    renderPerWorkspaceGitconfig({ ...base, git: { email: "e@x.dev" } }),
  ).toMatchSnapshot("email only")
  expect(
    renderPerWorkspaceGitconfig({ ...base, git: { name: "E" } }),
  ).toMatchSnapshot("name only")
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
