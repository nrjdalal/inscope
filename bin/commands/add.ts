import { parseArgs } from "node:util"
import { applyAll } from "@/apply"
import {
  configExists,
  defaultConfig,
  labelFromPath,
  loadConfig,
  saveConfig,
  upsertWorkspace,
  type Servers,
  type Workspace,
} from "@/config"
import { contractTilde } from "@/env"
import { keychainHas, keychainSet, keychainSetCommand } from "@/secrets"
import { promptHidden } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Map a directory to a GitHub account, git email, and MCP servers.
Re-running with the same path or label updates that workspace.

Usage:
  $ ${name} add <path> [options]

Options:
      --gh <account>        gh account whose token this workspace uses
      --email <email>       git commit email for this workspace
      --git-name <name>     git commit author name (optional)
      --label <name>        workspace name; defaults to the directory basename
      --servers <list>      comma-separated: github,linear,notion,slack
                            (default: github,linear,notion)
      --slack-keychain <s>  keychain service for the Slack token
                            (default: slack-<label>-mcp-xoxp when slack is on)
      --slack-message       allow the Slack MCP server to post messages
      --seed-slack          prompt for the Slack token and store it in the keychain
  -h, --help                Display help message`

export const add = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
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

  const target = positionals[0]
  if (!target) throw new Error(helpMessage)

  const label = values.label || labelFromPath(target)
  const list = (values.servers ?? "github,linear,notion")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const wantSlack =
    list.includes("slack") ||
    !!values["slack-keychain"] ||
    !!values["seed-slack"]
  const slackSvc = values["slack-keychain"] || `slack-${label}-mcp-xoxp`

  const servers: Servers = {
    github: list.includes("github"),
    linear: list.includes("linear"),
    notion: list.includes("notion"),
    slack: wantSlack
      ? { keychain: slackSvc, addMessageTool: !!values["slack-message"] }
      : false,
  }

  const git =
    values.email || values["git-name"]
      ? { email: values.email, name: values["git-name"] }
      : undefined

  const ws: Workspace = {
    name: label,
    path: contractTilde(target),
    gh: values.gh,
    git,
    servers,
  }

  const cfg = configExists() ? loadConfig() : defaultConfig()
  const next = upsertWorkspace(cfg, ws)
  saveConfig(next)
  applyAll(next)

  console.log(`✓ workspace "${label}" -> ${ws.path}`)
  console.log(`✓ regenerated the hook, git includes, and ${ws.path}/.mcp.json`)

  if (servers.slack) {
    if (values["seed-slack"]) {
      const token = await promptHidden(
        `Paste the Slack xoxp token for ${slackSvc}: `,
      )
      if (!token) {
        console.error("No token entered; skipped keychain write.")
      } else {
        keychainSet(slackSvc, token)
        console.log(`✓ stored ${slackSvc} in the macOS keychain`)
      }
    } else if (!keychainHas(slackSvc)) {
      console.log(
        `\nSlack token not in the keychain yet. Store it once with:\n  ${keychainSetCommand(slackSvc)}`,
      )
    }
  }

  console.log(
    `\nLaunch \`claude\` from ${ws.path} (or relaunch) to pick up the new identity.`,
  )
  process.exit(0)
}
