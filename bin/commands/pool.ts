import { parseArgs } from "node:util"

import { configPools, poolUsers, proxyAccounts, proxyUrl } from "@/proxy"
import { requireConfig } from "~/bin/commands/_config"
import { dim, orange, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Your pools of Claude accounts. Each pool is its own proxy, and a workspace's
conversations only ever use its pool's accounts: the shared login and every other
workspace use the default pool, and an isolated workspace can use its own
(\`${name} add <path> --pool <name>\`). Create a pool by signing an account in to it
(\`${name} login --pool <name>\`); an account lives in one pool only.

Usage:
  $ ${name} pool list [--json]

Options:
  -h, --help  Display help message`

export const pool = (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, json: { type: "boolean" } },
    args,
  })
  const sub = positionals[0] ?? "list"
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  if (sub !== "list") {
    console.error(`unknown pool command: ${sub}\n\n${helpMessage}`)
    process.exit(1)
  }
  const cfg = requireConfig()
  const pools = configPools(cfg).map((p) => ({
    pool: p.name,
    url: proxyUrl(p.port),
    accounts: proxyAccounts(p.name).map((a) => a.email),
    usedBy: poolUsers(cfg, p.name),
  }))
  if (values.json) {
    console.log(JSON.stringify(pools, null, 2))
    process.exit(0)
  }
  if (!pools.length) {
    console.log(`No pools yet. Sign an account in with \`${name} login\`.`)
    process.exit(0)
  }
  for (const p of pools) {
    console.log(`\n  ${orange(p.pool)}  ${dim(p.url)}`)
    console.log(`  accounts  ${p.accounts.length ? p.accounts.join(", ") : yellow("none")}`)
    console.log(`  used by   ${p.usedBy.length ? p.usedBy.join(", ") : dim("no workspace yet")}`)
  }
  process.exit(0)
}
