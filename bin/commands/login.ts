import { parseArgs } from "node:util"

import { signIn } from "@/accounts"
import { isProxyPort } from "@/config"
import { BROWSER_MODES, type BrowserMode, defaultBrowserMode } from "@/login"
import { DEFAULT_PROXY_PORT, proxyUrl } from "@/proxy"
import { green } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Sign a Claude account in to inscope. Every account lives in a local proxy
(CLIProxyAPI, 127.0.0.1 only), and every Claude Code login, the shared ~/.claude and
each isolated workspace's, sends its requests through it: when the account serving a
conversation hits its limit, the proxy carries the conversation on with the next one.
The first sign-in sets the proxy up (installs it, checksum-verified, and runs it at
login). Run it once per account; signing an account in again renews it.

Usage:
  $ ${name} login [options]

Options:
  --email <email>     the Claude account you expect to sign in; nothing is
                      pre-filled (you type it on the page), but if a different
                      account signs in, it is removed again
  --browser <mode>    chrome (default when Chrome is installed): a new Chrome window
                      on a fresh profile, opened on the sign-in page; you finish the
                      sign-in there, and the profile is deleted afterwards
                      system: your default browser (not a fresh profile)
                      none: print the sign-in URL to open yourself
  --port <n>          the port for a new proxy (default ${DEFAULT_PROXY_PORT})
  -h, --help          Display help message

Anthropic's terms forbid third parties that store or intermediate Claude.ai
credentials, which is what a proxy like this does: running it is your choice and
your accounts' risk.`

export const login = (args: string[]) =>
  (async () => {
    const { values } = parseArgs({
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        email: { type: "string" },
        browser: { type: "string" },
        port: { type: "string" },
      },
      args,
    })
    if (values.help) {
      console.log(helpMessage)
      process.exit(0)
    }
    const mode = (values.browser ?? defaultBrowserMode()) as BrowserMode
    if (!(BROWSER_MODES as readonly string[]).includes(mode)) {
      console.error(`Invalid --browser "${values.browser}": use ${BROWSER_MODES.join(", ")}`)
      process.exit(1)
    }
    const port = values.port === undefined ? undefined : Number(values.port)
    if (port !== undefined && !isProxyPort(port)) {
      console.error(`Invalid --port "${values.port}": use 1024-65535`)
      process.exit(1)
    }
    const res = await signIn({ email: values.email, mode, port })
    console.log(
      green(`\n✓ ${res.account.email} signed in`) +
        `\n  the proxy (${proxyUrl(res.port)}) holds ${res.accounts} account${res.accounts === 1 ? "" : "s"}; every Claude Code login goes through it` +
        `\n  Claude Code sessions started from now on use it. See the limits: ${name} usage`,
    )
    process.exit(0)
  })()
