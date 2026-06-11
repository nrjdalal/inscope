import { parseArgs } from "node:util"
import { applyAll } from "@/apply"
import { configExists, defaultConfig, loadConfig, saveConfig } from "@/config"
import { configPath } from "@/env"
import { name } from "~/package.json"

const helpMessage = `Set up inscope: create the config, generate the chpwd hook, and
source it from ~/.zshrc. Safe to run again; it never overwrites your config.

Usage:
  $ ${name} init

Options:
  -h, --help  Display help message`

export const init = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  let cfg
  if (configExists()) {
    cfg = loadConfig()
    console.log(`Using existing config at ${configPath()}`)
  } else {
    cfg = defaultConfig()
    saveConfig(cfg)
    console.log(`Created ${configPath()}`)
  }

  applyAll(cfg)
  console.log("Generated the chpwd hook and added a source line to ~/.zshrc.")
  console.log(`
Next steps:
  1. Reload your shell:           source ~/.zshrc   (or open a new terminal)
  2. Sign each GitHub account in: gh auth login
  3. Map a workspace:             ${name} add ~/acme --gh acme --email you@acme.com`)
  process.exit(0)
}
