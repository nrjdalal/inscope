import { parseArgs } from "node:util"
import { configExists, loadConfig, type Servers } from "@/config"
import { name } from "~/package.json"

const helpMessage = `List the configured workspaces. Run \`${name} doctor\` to verify
that their tokens and identities actually resolve.

Usage:
  $ ${name} list

Options:
  -h, --help  Display help message`

const enabledServers = (s: Servers) =>
  [
    s.github && "github",
    s.linear && "linear",
    s.notion && "notion",
    s.slack && "slack",
  ]
    .filter(Boolean)
    .join(", ") || "none"

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
    console.error(`No config found. Run \`${name} init\` first.`)
    process.exit(1)
  }

  const cfg = loadConfig()
  if (!cfg.workspaces.length) {
    console.log(
      `No workspaces yet. Add one with \`${name} add <path> --gh <account>\`.`,
    )
    process.exit(0)
  }

  for (const ws of cfg.workspaces) {
    console.log(`${ws.name}`)
    console.log(`  path     ${ws.path}`)
    console.log(`  gh       ${ws.gh ?? "(none)"}`)
    console.log(`  git      ${ws.git?.email ?? "(default)"}`)
    console.log(`  servers  ${enabledServers(ws.servers)}`)
    if (ws.servers.slack)
      console.log(`  slack    keychain: ${ws.servers.slack.keychain}`)
  }
  process.exit(0)
}
