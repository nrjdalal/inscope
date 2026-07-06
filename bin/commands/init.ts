import { parseArgs } from "node:util"

import { applyAll } from "@/apply"
import { configExists, defaultConfig, loadConfig, saveConfig } from "@/config"
import { configPath } from "@/env"
import { name } from "~/package.json"

const helpMessage = `Set up inscope: create the config, generate the chpwd hook, and
source it from ~/.zshrc. Safe to run again; it never overwrites your config.

Usage:
  $ ${name} init [options]

Options:
  --wrap-claude  emit a claude() launch wrapper into the hook (runs
                 \`claude update\` and passes --dangerously-skip-permissions);
                 edit "wrapClaude" in the config for finer control
  -h, --help     Display help message`

export const init = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "wrap-claude": { type: "boolean" },
    },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const existed = configExists()
  let cfg = existed ? loadConfig() : defaultConfig()

  // --wrap-claude sets a top-level key. Persist when creating a fresh config or
  // when the flag adds it to an existing one; otherwise leave the existing config
  // untouched (init never overwrites it). Rebuild the object so `wrapClaude`
  // serializes right after `version`, above `workspaces`.
  const changed = Boolean(values["wrap-claude"])
  if (changed) {
    const { workspaces, ...rest } = cfg
    rest.wrapClaude = true
    cfg = { ...rest, workspaces }
  }
  if (!existed || changed) saveConfig(cfg)

  console.log(existed ? `\nUsing existing config at ${configPath()}` : `\nCreated ${configPath()}`)

  applyAll(cfg)
  console.log("Generated the chpwd hook and added a source line to ~/.zshrc.")
  console.log(`
Next steps:
  1. Reload your shell:           source ~/.zshrc   (or open a new terminal)
  2. Map a workspace:             ${name} add ~/acme`)
  process.exit(0)
}
