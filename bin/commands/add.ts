import { parseArgs } from "node:util"
import { labelFromPath, type Workspace } from "@/config"
import { contractTilde } from "@/env"
import { ghAccounts, gitGlobal } from "@/secrets"
import {
  isInteractive,
  promptConfirm,
  promptText,
  selectMany,
  selectOne,
} from "~/bin/commands/_prompt"
import {
  buildServers,
  finalizeSlack,
  persist,
  SLACK_AUTH_DOCS,
  slackKeychainFor,
} from "~/bin/commands/_workspace"
import { name } from "~/package.json"

const helpMessage = `Map a directory to a GitHub account, git email, and MCP servers.
Runs interactively in a terminal; pass flags or -y to skip the prompts. Re-running
with the same path or label updates that workspace.

Usage:
  $ ${name} add [path] [options]

Options:
      --gh <account>        gh account whose token this workspace uses
      --email <email>       git commit email (omit to inherit your global identity)
      --git-name <name>     git commit author name (omit to inherit global)
      --label <name>        workspace name; defaults to the directory basename
      --servers <list>      comma-separated: github,linear,notion,slack
                            (default: github)
      --slack-keychain <s>  keychain service for the Slack token
                            (default: SLACK_MCP_XOXP_TOKEN_<LABEL> when slack is on)
      --slack-message       allow the Slack MCP server to post messages
      --seed-slack          prompt for the Slack token and store it in the keychain
  -y, --yes                 accept defaults, skip all prompts (non-interactive)
  -h, --help                Display help message`

const SERVER_CHOICES = [
  { label: "github", value: "github", checked: true },
  { label: "linear", value: "linear", checked: false },
  { label: "notion", value: "notion", checked: false },
  { label: "slack", value: "slack", checked: false },
]

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

  // --- path ---
  let target = positionals[0]
  if (!target) {
    if (interactive)
      target = await promptText("Workspace directory", process.cwd())
    else throw new Error(helpMessage)
  }

  // --- label ---
  let label = values.label || labelFromPath(target)
  if (interactive && !values.label) label = await promptText("Label", label)

  // --- gh account ---
  let gh = values.gh
  if (gh === undefined && interactive) {
    const choices = [
      ...ghAccounts().map((a) => ({ label: a, value: a })),
      { label: "(none)", value: "" },
    ]
    gh =
      (await selectOne("GitHub account for this workspace", choices)) ||
      undefined
  }

  // --- git identity (empty answer inherits the global config) ---
  let email = values.email
  let gitName = values["git-name"]
  if (interactive) {
    if (email === undefined) {
      const g = gitGlobal("user.email")
      email =
        (await promptText(
          `Git email${g ? ` [${g} · global]` : ""} (enter to inherit global)`,
        )) || undefined
    }
    if (gitName === undefined) {
      const g = gitGlobal("user.name")
      gitName =
        (await promptText(
          `Git name${g ? ` [${g} · global]` : ""} (enter to inherit global)`,
        )) || undefined
    }
  }

  // --- MCP servers ---
  let serverList: string[]
  if (values.servers !== undefined) {
    serverList = values.servers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (interactive) {
    serverList = await selectMany(
      "MCP servers (space toggles, enter confirms)",
      SERVER_CHOICES,
    )
  } else {
    serverList = ["github"]
  }

  // --- slack details ---
  const wantSlack =
    serverList.includes("slack") ||
    !!values["slack-keychain"] ||
    !!values["seed-slack"]
  let slackSvc = values["slack-keychain"] || slackKeychainFor(label)
  let slackMessage = !!values["slack-message"]
  let seedSlack = !!values["seed-slack"]
  if (wantSlack && interactive) {
    console.log(
      `\nSlack uses a user OAuth (xoxp) token. If you haven't created the app yet,\nfollow the setup guide:\n  ${SLACK_AUTH_DOCS}`,
    )
    if (!values["slack-keychain"])
      slackSvc = await promptText("Slack keychain service", slackSvc)
    if (!values["slack-message"])
      slackMessage = await promptConfirm("Allow Slack to post messages?", true)
    if (!values["seed-slack"])
      seedSlack = await promptConfirm("Store the Slack token now?", true)
  }

  const ws: Workspace = {
    name: label,
    path: contractTilde(target),
    gh,
    git: email || gitName ? { email, name: gitName } : undefined,
    servers: buildServers(
      serverList,
      wantSlack ? { keychain: slackSvc, addMessageTool: slackMessage } : null,
    ),
  }

  persist(ws)
  console.log(`\n✓ workspace "${label}" -> ${ws.path}`)
  console.log(`✓ regenerated the hook, git includes, and ${ws.path}/.mcp.json`)
  await finalizeSlack(ws, seedSlack)
  console.log(
    `\nLaunch \`claude\` from ${ws.path} (or relaunch) to pick up the new identity.`,
  )
  process.exit(0)
}
