import { parseArgs } from "node:util"

import { configExists, defaultConfig, loadConfig } from "@/config"
import { renderUsage, resolveUsage, usageJson } from "@/usage"
import { dim, green, orange, red, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Show your Claude accounts' subscription limits: for each account in the proxy
(\`${name} login\`), its plan and its 5-hour and weekly usage, and when each resets.

Usage is read from Anthropic's subscription usage endpoint (the one behind Claude
Code's /usage), with each account's own token from the proxy, read-only.

Usage:
  $ ${name} usage [options]

Options:
  --json      print the rows as JSON
  -h, --help  Display help message`

export const usage = async (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    args,
  })
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const cfg = configExists() ? loadConfig() : defaultConfig()
  const rows = await resolveUsage(cfg)
  if (values.json) {
    console.log(JSON.stringify(usageJson(rows), null, 2))
    process.exit(0)
  }
  if (!rows.length) {
    console.log(`No Claude accounts yet. Sign one in with \`${name} login\`.`)
    process.exit(0)
  }
  console.log()
  console.log(
    renderUsage(rows, Date.now(), { head: orange, ok: green, warn: yellow, bad: red, dim }),
  )
  console.log(dim("\n  % used · time until it resets"))
  process.exit(0)
}
