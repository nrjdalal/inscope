import { parseArgs } from "node:util"

import { accountDir } from "@/accounts"
import { accountUsers, findAccount, removeAccount, saveConfig } from "@/config"
import { contractTilde } from "@/env"
import { logoutAccount } from "@/login"
import { shQuotePath } from "@/secrets"
import { requireConfig } from "~/bin/commands/_config"
import { orange } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Sign a named account out and forget it.
Runs \`claude auth logout\` on the account's own config dir (which deletes its
Keychain token) and removes it from the config. Refuses while a workspace still uses
the account; move those first with \`${name} edit\`. The account's dir, with its
session history, is left in place.

Usage:
  $ ${name} logout <name>

Options:
  --force     forget the account even if \`claude auth logout\` fails (its Keychain
              token may then remain)
  -h, --help  Display help message`

export const logout = (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, force: { type: "boolean" } },
    args,
  })
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const accountName = positionals[0]
  if (!accountName) {
    console.error(helpMessage)
    process.exit(1)
  }
  const cfg = requireConfig()
  if (!findAccount(cfg, accountName)) {
    console.error(`No account named "${accountName}". See \`${name} usage\` for your accounts.`)
    process.exit(1)
  }
  const users = accountUsers(cfg, accountName)
  if (users.length) {
    console.error(
      `Account "${accountName}" is used by ${users.join(", ")}; move them to another login with \`${name} edit\` first. Nothing was changed.`,
    )
    process.exit(1)
  }
  const signedOut = logoutAccount(accountName)
  if (!signedOut && !values.force) {
    console.error(
      `\`claude auth logout\` failed for account "${accountName}", so its Keychain token may remain; nothing was changed. Retry, or pass --force to forget it anyway.`,
    )
    process.exit(1)
  }
  saveConfig(removeAccount(cfg, accountName))
  const dir = contractTilde(accountDir(accountName))
  console.log(`\n✓ ${signedOut ? "signed out and removed" : "removed"} account "${accountName}"`)
  if (!signedOut)
    console.log(
      `Note: \`claude auth logout\` did not succeed there; its Keychain token may remain.`,
    )
  console.log(
    `\nNote: ${dir} still holds that login's history; it was left in place.\n` +
      `Delete it with: ${orange(`rm -rf ${shQuotePath(dir)}`)}`,
  )
  process.exit(0)
}
