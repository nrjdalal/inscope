import { parseArgs } from "node:util"

import { accountDir } from "@/accounts"
import {
  accountNameError,
  configExists,
  defaultConfig,
  findAccount,
  loadConfig,
  saveConfig,
  upsertAccount,
} from "@/config"
import { contractTilde } from "@/env"
import { applyAccountsBypass } from "@/generators/settings"
import { BROWSER_MODES, type BrowserMode, defaultBrowserMode, loginAccount } from "@/login"
import { green, isInteractive, promptText } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Sign a Claude account in as a named account inscope keeps for you.
Runs Claude Code's own \`claude auth login\` with the account's own config dir
(~/.config/inscope/accounts/<name>), so Claude stores the login in its own Keychain
slot; inscope never stores or refreshes it. Assign the account to a workspace with
\`${name} add <path> --account <name>\` (or \`${name} edit\`). Re-running login on an
existing name signs that account in again.

Usage:
  $ ${name} login <name> [options]

Options:
  --email <email>     the Claude account you expect to sign in; nothing is
                      pre-filled (you type it on the page), but if a different
                      account signs in, it is signed back out and nothing is saved
  --browser <mode>    chrome (default when Chrome is installed): a new Chrome window
                      on a fresh profile, opened on the sign-in page; you finish the
                      sign-in there, and the profile is deleted afterwards
                      system: your default browser
                      none: print the sign-in URL to open yourself
  -h, --help          Display help message`

export const login = (args: string[]) =>
  (async () => {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        email: { type: "string" },
        browser: { type: "string" },
      },
      args,
    })
    if (values.help) {
      console.log(helpMessage)
      process.exit(0)
    }

    let accountName = positionals[0]
    if (!accountName && isInteractive()) accountName = await promptText("Account name")
    if (!accountName) {
      console.error(helpMessage)
      process.exit(1)
    }
    const nameErr = accountNameError(accountName)
    if (nameErr) {
      console.error(`Invalid account name "${accountName}": ${nameErr}`)
      process.exit(1)
    }

    const mode = (values.browser ?? defaultBrowserMode()) as BrowserMode
    if (!(BROWSER_MODES as readonly string[]).includes(mode)) {
      console.error(`Invalid --browser "${values.browser}": use ${BROWSER_MODES.join(", ")}`)
      process.exit(1)
    }

    const cfg = configExists() ? loadConfig() : defaultConfig()
    const prior = findAccount(cfg, accountName)
    const email = values.email ?? prior?.email
    console.log(
      `\n${prior ? "Signing account" : "Adding account"} "${accountName}" in ${contractTilde(accountDir(accountName))}`,
    )
    if (mode === "chrome")
      console.log(
        "A new Chrome window (a fresh profile, deleted afterwards) opens on Claude's sign-in page. Enter the account's email, then the code Claude emails you, then authorize Claude Code. This finishes on its own once you do.",
      )
    else if (mode === "none")
      console.log("Open the sign-in URL below in the browser you want to sign in with.")
    console.log()

    const result = loginAccount({
      name: accountName,
      email,
      mode,
      existing: Boolean(prior),
      currentAccounts: () => (configExists() ? loadConfig() : cfg).accounts ?? [],
    })

    // Re-read: the login can take minutes, and another inscope command may have saved
    // the config meanwhile.
    const latest = configExists() ? loadConfig() : cfg
    const next = upsertAccount(latest, { name: accountName, email: result.email })
    saveConfig(next)
    applyAccountsBypass(next)

    console.log(
      green(`\n✓ account "${accountName}" -> ${result.email}`) +
        `\nAssign it to a workspace: ${name} add <path> --account ${accountName}` +
        `\nSee its limits: ${name} usage`,
    )
    process.exit(0)
  })()
