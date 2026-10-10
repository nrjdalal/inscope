import { parseArgs } from "node:util"

import { signOut } from "@/accounts"
import { DEFAULT_POOL } from "@/proxy"
import { requireConfig } from "~/bin/commands/_config"
import { green } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Remove a Claude account from inscope's proxy, from whichever pool holds it. Its
tokens are deleted from the proxy; the account itself is untouched. A pool's last
account cannot be removed while a login uses that pool (the default pool always: the
shared login runs on it); the last account of an unused named pool takes the pool
with it. To stop using the proxy altogether, run \`${name} proxy uninstall\`.

Usage:
  $ ${name} logout <email>

Options:
  -h, --help  Display help message`

export const logout = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
    args,
  })
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const email = positionals[0]
  if (!email) {
    console.error(helpMessage)
    process.exit(1)
  }
  const cfg = requireConfig()
  if (!cfg.proxy) {
    console.error(`No accounts yet. Sign one in with \`${name} login\`.`)
    process.exit(1)
  }
  const res = await signOut(cfg, email)
  console.log(
    green(
      `\n✓ removed ${email} from ${res.pool === DEFAULT_POOL ? "the proxy" : `pool ${res.pool}`}`,
    ) +
      (res.poolRemoved
        ? `\n  it was the pool's last account, so pool ${res.pool} is gone too`
        : ""),
  )
  process.exit(0)
}
