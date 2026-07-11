import { parseArgs } from "node:util"

import { applyAll } from "@/apply"
import { findWorkspace, removeWorkspace, saveConfig, type Workspace } from "@/config"
import { removePerWorkspaceGitconfig } from "@/generators/gitconfig"
import { removeMcp } from "@/generators/mcp"
import { removeSkills } from "@/generators/skills"
import { requireConfig } from "~/bin/commands/_config"
import { isInteractive, orange, promptText, selectOne } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Remove a workspace mapping. Drops its git include and the MCP
servers inscope manages; leaves your keychain and gh accounts untouched. Pick a
workspace, or pass its path/label.

Usage:
  $ ${name} rm [path|label]

Options:
  -y, --yes   Skip the type-the-label confirmation
  -h, --help  Display help message`

export const remove = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      yes: { type: "boolean", short: "y" },
    },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const cfg = requireConfig()
  if (!cfg.workspaces.length) {
    console.error("No workspaces to remove.")
    process.exit(1)
  }

  const key = positionals[0]
  let target: Workspace
  if (key) {
    const found = findWorkspace(cfg, key)
    if (!found) {
      console.error(`No workspace matching "${key}".`)
      process.exit(1)
    }
    target = found
  } else if (isInteractive()) {
    target = await selectOne(
      "Remove which workspace?",
      cfg.workspaces.map((w) => ({
        label: `${w.name}  (${w.path})`,
        value: w,
      })),
    )
  } else {
    console.error(`Specify a workspace, e.g. \`${name} rm <label>\`.`)
    process.exit(1)
  }

  if (!values.yes) {
    console.log(`\n⚠ Removing "${target.name}" (${target.path}) unmaps it from inscope.`)
    const typed = await promptText(`Type "${target.name}" to confirm`)
    if (typed !== target.name) {
      console.error(`Aborted: "${typed}" does not match "${target.name}".`)
      process.exit(1)
    }
  }

  const { cfg: next } = removeWorkspace(cfg, target.name)
  removeMcp(target)
  removePerWorkspaceGitconfig(target.name)
  // Symlinks into a shared cache are disposable, so we clean them up outright
  // (unlike .inscope/keychain, which hold a login/secret and are left with a
  // note). applyAll only touches remaining workspaces, so this must be explicit.
  removeSkills(target)
  saveConfig(next)
  applyAll(next)

  console.log(`\n✓ removed workspace "${target.name}"`)
  if (target.isolate) {
    console.log(
      `\nNote: ${target.path}/.inscope still holds a Claude login; it was left in place.\n` +
        `Delete it with: ${orange(`rm -rf ${target.path}/.inscope`)}`,
    )
  }
  if (target.servers.slack) {
    console.log(
      `\nNote: the keychain entry ${target.servers.slack.keychain} was left in place.\n` +
        `Delete it with: ${orange(`security delete-generic-password -s ${target.servers.slack.keychain}`)}`,
    )
  }
  process.exit(0)
}
