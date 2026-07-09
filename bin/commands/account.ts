import fs from "node:fs"

import { isSignedIn, listRegistry } from "@/accounts"
import { workspaceNameError } from "@/config"
import { accountDir, contractTilde } from "@/env"
import { claudeAuthStatus } from "@/secrets"
import { green, orange, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Manage the pool of Claude logins a workspace can switch between.
Each account is a signed-in Claude config dir under ~/.config/inscope/accounts/<name>;
a workspace draws from them with "accounts": ["<name>", ...] (requires isolate).

Usage:
  $ ${name} account add <name>     Scaffold an account dir and print how to sign in
  $ ${name} account list           List registry accounts and their sign-in state

Options:
  -h, --help  Display help message`

export const account = (args: string[]) => {
  const sub = args[0]
  const rest = args.slice(1)
  if (!sub || sub === "-h" || sub === "--help") {
    console.log(helpMessage)
    process.exit(0)
  }

  if (sub === "add") {
    const acctName = rest[0]
    if (!acctName) {
      console.error(`Usage: ${name} account add <name>`)
      process.exit(1)
    }
    const err = workspaceNameError(acctName)
    if (err) {
      console.error(`Invalid account name "${acctName}": ${err}`)
      process.exit(1)
    }
    const dir = accountDir(acctName)
    fs.mkdirSync(dir, { recursive: true })
    console.log(`\n✓ account "${acctName}" -> ${contractTilde(dir)}`)
    console.log(`\nSign in once (then any workspace that lists it can use it):`)
    console.log(`  ${orange(`CLAUDE_CONFIG_DIR=${contractTilde(dir)} claude`)}`)
    console.log(
      `\nThen add it to a workspace pool: \`"accounts": ["${acctName}", ...]\` (needs isolate), and \`${name} apply\`.`,
    )
    process.exit(0)
  }

  if (sub === "list" || sub === "ls") {
    const accounts = listRegistry()
    if (!accounts.length) {
      console.log(`No accounts yet. Add one with \`${name} account add <name>\`.`)
      process.exit(0)
    }
    console.log()
    for (const a of accounts) {
      const signedIn = isSignedIn(a)
      const auth = signedIn ? claudeAuthStatus(accountDir(a)) : null
      const who = auth?.signedIn
        ? `${auth.email ?? ""}${auth.subscriptionType ? ` · ${auth.subscriptionType}` : ""}`
        : yellow("not signed in")
      console.log(`  ${signedIn ? green("●") : yellow("○")} ${a}  ${who}`)
    }
    process.exit(0)
  }

  console.error(`Unknown \`account\` subcommand "${sub}". Available: add, list.`)
  process.exit(1)
}
