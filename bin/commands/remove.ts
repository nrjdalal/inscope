import { parseArgs } from "node:util"
import { applyAll } from "@/apply"
import { configExists, loadConfig, removeWorkspace, saveConfig } from "@/config"
import { removePerWorkspaceGitconfig } from "@/generators/gitconfig"
import { removeMcp } from "@/generators/mcp"
import { name } from "~/package.json"

const helpMessage = `Remove a workspace mapping. Drops its git include and the MCP
servers inscope manages; leaves your keychain and gh accounts untouched.

Usage:
  $ ${name} rm <path|label>

Options:
  -h, --help  Display help message`

export const remove = (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const key = positionals[0]
  if (!key) throw new Error(helpMessage)

  if (!configExists()) {
    console.error(`No config found. Run \`${name} init\` first.`)
    process.exit(1)
  }

  const cfg = loadConfig()
  const { cfg: next, removed } = removeWorkspace(cfg, key)
  if (!removed) {
    console.error(`No workspace matching "${key}".`)
    process.exit(1)
  }

  removeMcp(removed)
  removePerWorkspaceGitconfig(removed.name)
  saveConfig(next)
  applyAll(next)

  console.log(`✓ removed workspace "${removed.name}"`)
  if (removed.servers.slack) {
    console.log(
      `Note: the keychain entry ${removed.servers.slack.keychain} was left in place.\n` +
        `Delete it with: security delete-generic-password -s ${removed.servers.slack.keychain}`,
    )
  }
  process.exit(0)
}
