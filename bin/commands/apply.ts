import { parseArgs } from "node:util"

import { applyAll } from "@/apply"
import { configExists, loadConfig } from "@/config"
import { name } from "~/package.json"

const helpMessage = `Regenerate the chpwd hook, git includes, every .mcp.json, and
each workspace's skill links from your config. Idempotent: run it any time the
config changes.

Usage:
  $ ${name} apply

Options:
  -h, --help  Display help message`

export const apply = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  if (!configExists()) {
    console.error(`No config found. Run \`${name} init\` first.`)
    process.exit(1)
  }

  const cfg = loadConfig()
  const res = applyAll(cfg)

  console.log(`\n✓ hook       ${res.hook}`)
  if (res.gitconfig) console.log(`✓ gitconfig  ~/.gitconfig (includeIf block)`)
  for (const m of res.mcp) console.log(`✓ mcp        ${m}`)
  console.log(`\nApplied ${cfg.workspaces.length} workspace(s).`)
  process.exit(0)
}
