import { parseArgs } from "node:util"

import { normalizeSkill } from "@/config"
import { requireConfig } from "~/bin/commands/_config"
import { enabledServers } from "~/bin/commands/_workspace"
import { name } from "~/package.json"

const helpMessage = `List the configured workspaces. Run \`${name} doctor\` to verify
that their tokens and identities actually resolve.

Usage:
  $ ${name} list

Options:
      --json  Print the workspaces as JSON
  -h, --help  Display help message`

export const list = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, json: { type: "boolean" } },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const cfg = requireConfig()
  if (values.json) {
    const out = cfg.workspaces.map((ws) => ({
      name: ws.name,
      path: ws.path,
      gh: ws.gh ?? null,
      isolate: Boolean(ws.isolate),
      git: ws.git?.email ?? null,
      servers: enabledServers(ws.servers),
      slack: ws.servers.slack ? { keychain: ws.servers.slack.keychain } : null,
      skills: ws.skills?.map((s) => normalizeSkill(s).name) ?? [],
    }))
    console.log(JSON.stringify(out, null, 2))
    process.exit(0)
  }
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
