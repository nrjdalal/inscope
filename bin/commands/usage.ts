import { parseArgs } from "node:util"

import { renderUsage, resolveUsage, usageJson } from "@/usage"
import { requireConfig } from "~/bin/commands/_config"
import { dim, green, orange, red, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Show each Claude login's subscription limits: the 5-hour and weekly
usage and when each resets, for your base login, every account (\`${name} login\`),
and every signed-in isolated workspace.

Usage is read from Anthropic's subscription usage endpoint (the one behind Claude
Code's /usage), using each login's own token from the Keychain, read-only. A login
whose token has expired shows as expired: inscope never refreshes a token itself.

Usage:
  $ ${name} usage [options]

Options:
  --refresh   first let Claude Code refresh any expired login by sending it a
              one-word Haiku prompt (uses a sliver of that account's usage)
  --json      print the rows as JSON
  -h, --help  Display help message`

export const usage = async (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      refresh: { type: "boolean" },
    },
    args,
  })
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const cfg = requireConfig()
  const rows = await resolveUsage(cfg, {
    refresh: values.refresh,
    onRefresh: (label) => console.error(dim(`refreshing ${label}...`)),
  })
  if (values.json) {
    console.log(JSON.stringify(usageJson(rows), null, 2))
    process.exit(0)
  }
  console.log()
  console.log(
    renderUsage(rows, Date.now(), { head: orange, ok: green, warn: yellow, bad: red, dim }),
  )
  console.log(dim("\n  % used · time until it resets"))
  process.exit(0)
}
