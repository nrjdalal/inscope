import { parseArgs } from "node:util"

import { configExists, loadConfig, normalizeSkill } from "@/config"
import { enabledServers } from "~/bin/commands/_workspace"
import { name } from "~/package.json"

const helpMessage = `List the configured workspaces. Run \`${name} doctor\` to verify
that their tokens and identities actually resolve.

Usage:
  $ ${name} list

Options:
  -h, --help  Display help message`

export const list = (args: string[]) => {
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
    console.error(`No config found. Run \`${name} add <path>\` first.`)
    process.exit(1)
  }

  const cfg = loadConfig()
  if (!cfg.workspaces.length) {
    console.log(`No workspaces yet. Add one with \`${name} add <path> --gh <account>\`.`)
    process.exit(0)
  }

  for (const ws of cfg.workspaces) {
    console.log(`\n${ws.name}`)
    console.log(`  path     ${ws.path}`)
    console.log(`  gh       ${ws.gh ?? "(none)"}`)
    if (ws.isolate) console.log(`  claude   ${ws.path}/.inscope (isolated login)`)
    console.log(`  git      ${ws.git?.email ?? "(default)"}`)
    console.log(`  servers  ${enabledServers(ws.servers).join(", ") || "none"}`)
    if (ws.servers.slack) console.log(`  slack    keychain: ${ws.servers.slack.keychain}`)
    if (ws.skills?.length)
      console.log(`  skills   ${ws.skills.map((s) => normalizeSkill(s).name).join(", ")}`)
  }
  process.exit(0)
}
