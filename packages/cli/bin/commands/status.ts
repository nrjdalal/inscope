import { parseArgs } from "node:util"

import { renderStatus, resolveStatus } from "@/status"
import { requireConfig } from "~/bin/commands/_config"
import { dim, green, orange, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Show the identity resolved for the current directory: the Claude
login (email + subscription), GitHub account, git email, MCP servers, and skills.

Usage:
  $ ${name} status [--json]
  $ ${name} whoami [--json]   (alias of status)

Options:
      --json  Print the resolved identity as JSON
  -h, --help  Display help message`

export const status = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, json: { type: "boolean" } },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const snap = resolveStatus(requireConfig())
  if (values.json) {
    console.log(JSON.stringify(snap, null, 2))
    process.exit(0)
  }
  console.log(`\n${renderStatus(snap, { head: orange, ok: green, warn: yellow, dim })}`)
  process.exit(0)
}
