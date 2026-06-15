import fs from "node:fs"
import { parseArgs } from "node:util"

import {
  configExists,
  hookValueError,
  labelFromPath,
  loadConfig,
  pathConflict,
  type SlackPackage,
  type Workspace,
  workspaceNameError,
  workspacePathError,
} from "@/config"
import { contractTilde, resolveAbsolute } from "@/env"
import { SERVER_TYPES } from "@/generators/mcp"
import { ghAccounts, gitGlobal } from "@/secrets"
import {
  isInteractive,
  promptConfirm,
  promptText,
  selectMany,
  selectOne,
  yellow,
} from "~/bin/commands/_prompt"
import {
  buildServers,
  finalizeSlack,
  gitGlobalHint,
  persist,
  resolveSlackPackage,
  SLACK_PACKAGE_CHOICES,
  slackKeychainFor,
} from "~/bin/commands/_workspace"
import { name } from "~/package.json"

const helpMessage = `Map a directory to a GitHub account, git email, and MCP servers.
Runs interactively in a terminal; pass flags or -y to skip the prompts. Re-running
with the same label updates that workspace; each directory maps to one workspace.

Usage:
  $ ${name} add [path] [options]

Options:
  --gh <account>        gh account whose token this workspace uses
  --email <email>       git commit email (omit to inherit your global identity)
  --git-name <name>     git commit author name (omit to inherit global)
  --label <name>        workspace name; defaults to the directory basename
  --servers <list>      comma-separated, any of: github, atlassian, canva,
                        clickup, hubspot, intercom, linear, monday, notion,
                        plane, sentry, slack, stripe, vercel, webflow
                        (default: github)
  --slack-keychain <s>  keychain service for the Slack token
                        (default: SLACK_MCP_XOXP_TOKEN_<LABEL> when slack is on)
  --slack-package <p>   Slack MCP server package: slack-mcp-server (default,
                        pinned) or @nrjdalal/slack-mcp-server (latest)
  --slack-message       allow the Slack MCP server to post messages
  --seed-slack          prompt for the Slack token and store it in the keychain
  -y, --yes             accept defaults, skip all prompts (non-interactive)
  -h, --help            Display help message`

const SERVER_CHOICES = SERVER_TYPES.map((t) => ({
  label: t,
  value: t,
  checked: t === "github",
}))

export const add = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      yes: { type: "boolean", short: "y" },
      gh: { type: "string" },
      email: { type: "string" },
      "git-name": { type: "string" },
      label: { type: "string" },
      servers: { type: "string" },
      "slack-keychain": { type: "string" },
      "slack-package": { type: "string" },
      "slack-message": { type: "boolean" },
      "seed-slack": { type: "boolean" },
    },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const interactive = isInteractive() && !values.yes
  if (interactive) console.log()

  // --- path ---
  let target = positionals[0]
  if (!target) {
    if (interactive) target = await promptText("Workspace directory", process.cwd())
    else throw new Error(helpMessage)
  }
  const pathErr = workspacePathError(target)
  if (pathErr) {
    console.error(`\nInvalid workspace path "${target}": ${pathErr}`)
    process.exit(1)
  }
  // apply creates the .mcp.json (and its parent) on persist, so a typo'd path is
  // otherwise created silently. Warn but don't block: the dir may not exist yet.
  if (!fs.existsSync(resolveAbsolute(target))) {
    console.error(
      yellow(`Warning: ${contractTilde(target)} does not exist yet; it will be created.`) + "\n",
    )
  }

  // --- label ---
  let label = values.label || labelFromPath(target)
  if (interactive && !values.label) label = await promptText("Label", label)
  const labelErr = workspaceNameError(label)
  if (labelErr) {
    console.error(`\nInvalid label "${label}": ${labelErr}`)
    process.exit(1)
  }

  // A directory maps to exactly one workspace (one hook arm, one .mcp.json).
  // Adding a second label for a path another workspace already owns would create
  // a broken duplicate, so refuse and point at the existing one. Re-running with
  // the same label updates that workspace, so only a different name collides.
  if (configExists()) {
    const owner = pathConflict(loadConfig(), target, label)
    if (owner) {
      console.error(
        `\n${contractTilde(target)} is already mapped to workspace "${owner.name}". Run \`${name} edit ${owner.name}\` to change it, or \`${name} rm ${owner.name}\` first.`,
      )
      process.exit(1)
    }
  }

  // --- gh account ---
  let gh = values.gh
  if (gh === undefined && interactive) {
    const choices = [
      ...ghAccounts().map((a) => ({ label: a, value: a })),
      { label: "(none)", value: "" },
    ]
    gh = (await selectOne("\nGitHub account for this workspace", choices)) || undefined
  }

  // --- git identity (blank inherits the global config, or leaves it unset when
  // there is no global to inherit) ---
  let email = values.email
  let gitName = values["git-name"]
  if (interactive) {
    if (email === undefined) {
      email =
        (await promptText(`Git email (${gitGlobalHint(gitGlobal("user.email"))})`)) || undefined
    }
    if (gitName === undefined) {
      gitName =
        (await promptText(`Git name (${gitGlobalHint(gitGlobal("user.name"))})`)) || undefined
    }
  }

  // --- MCP servers ---
  let serverList: string[]
  if (values.servers !== undefined) {
    serverList = values.servers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const known = new Set<string>(SERVER_TYPES)
    const unknown = serverList.filter((s) => !known.has(s))
    if (unknown.length) {
      console.error(yellow(`\nIgnoring unknown server(s): ${unknown.join(", ")}`))
    }
  } else if (interactive) {
    serverList = await selectMany("MCP servers (space toggles, enter confirms)", SERVER_CHOICES)
  } else {
    serverList = ["github"]
  }

  // --- slack details ---
  const wantSlack =
    serverList.includes("slack") || !!values["slack-keychain"] || !!values["seed-slack"]
  let slackSvc = values["slack-keychain"] || slackKeychainFor(label)
  let slackMessage = !!values["slack-message"]
  let seedSlack = !!values["seed-slack"]
  const resolvedPkg = resolveSlackPackage(values["slack-package"])
  if (resolvedPkg === null) {
    console.error(
      `\nInvalid --slack-package "${values["slack-package"]}": use slack-mcp-server or @nrjdalal/slack-mcp-server`,
    )
    process.exit(1)
  }
  let slackPackage: SlackPackage = resolvedPkg
  if (wantSlack && interactive) {
    console.log(`\nSlack uses a user OAuth (xoxp) token.`)
    if (!values["slack-package"]) {
      const initial = Math.max(
        0,
        SLACK_PACKAGE_CHOICES.findIndex((c) => c.value === slackPackage),
      )
      slackPackage = await selectOne("Slack MCP server package", SLACK_PACKAGE_CHOICES, initial)
    }
    if (!values["slack-keychain"]) slackSvc = await promptText("Slack keychain service", slackSvc)
    if (!values["slack-message"])
      slackMessage = await promptConfirm("Allow Slack to post messages?", true)
    if (!values["seed-slack"]) seedSlack = await promptConfirm("Store the Slack token now?", true)
  }

  // gh account and Slack keychain are interpolated into the chpwd hook; reject
  // values that would break out of the quoting (the --gh / --slack-keychain
  // flags and the keychain prompt are otherwise unchecked).
  const ghErr = gh ? hookValueError(gh) : null
  if (ghErr) {
    console.error(`\nInvalid gh account "${gh}": ${ghErr}`)
    process.exit(1)
  }
  if (wantSlack) {
    const svcErr = hookValueError(slackSvc)
    if (svcErr) {
      console.error(`\nInvalid Slack keychain service "${slackSvc}": ${svcErr}`)
      process.exit(1)
    }
  }

  const ws: Workspace = {
    name: label,
    path: contractTilde(target),
    gh,
    git: email || gitName ? { email, name: gitName } : undefined,
    servers: buildServers(
      serverList,
      wantSlack
        ? { keychain: slackSvc, addMessageTool: slackMessage, package: slackPackage }
        : null,
    ),
  }

  persist(ws)
  console.log(`\n✓ workspace "${label}" -> ${ws.path}`)
  console.log(`✓ regenerated the hook, git includes, and ${ws.path}/.mcp.json`)
  await finalizeSlack(ws, seedSlack)
  console.log(`\nLaunch \`claude\` from ${ws.path} (or relaunch) to pick up the new identity.`)
  process.exit(0)
}
