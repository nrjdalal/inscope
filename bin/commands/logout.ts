import { parseArgs } from "node:util"

import { signOut } from "@/accounts"
import { requireConfig } from "~/bin/commands/_config"
import { green } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Remove a Claude account from inscope's proxy. Its tokens are deleted from the
proxy; the account itself is untouched. The proxy's last account cannot be removed
this way, since every Claude Code login goes through the proxy: to stop using it,
run \`${name} proxy uninstall\`.

Usage:
  $ ${name} logout <email>

Options:
  -h, --help  Display help message`

export const logout = (args: string[]) => {
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
  signOut(email)
  console.log(green(`\n✓ removed ${email} from the proxy`))
  process.exit(0)
}
