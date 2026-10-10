import { parseArgs } from "node:util"

import { applyAll, preflightApply } from "@/apply"
import { configExists, defaultConfig, isProxyPort, loadConfig, saveConfig } from "@/config"
import { BROWSER_MODES, type BrowserMode, defaultBrowserMode } from "@/login"
import {
  DEFAULT_PROXY_PORT,
  loginProxyAccount,
  proxyAccounts,
  proxyHealthy,
  proxyUrl,
  readProxyKey,
  setupProxy,
} from "@/proxy"
import { defaultRunner } from "@/secrets"
import { dim, green } from "~/bin/commands/_prompt"
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

    const cfg = configExists() ? loadConfig() : defaultConfig()
    const port = cfg.proxy?.port ?? (values.port ? Number(values.port) : DEFAULT_PROXY_PORT)
    if (!isProxyPort(port)) {
      console.error(`Invalid --port "${values.port}": use 1024-65535`)
      process.exit(1)
    }
    if (cfg.proxy && values.port && Number(values.port) !== cfg.proxy.port) {
      console.error(
        `The proxy already runs on port ${cfg.proxy.port}; change it with \`${name} proxy setup --port ${values.port}\`.`,
      )
      process.exit(1)
    }
    // Routing every login through the proxy must be possible before anyone signs in:
    // a settings.json with a key helper of its own stops here, not after the sign-in.
    const routed = { ...cfg, proxy: { port } }
    preflightApply(routed)

    if (!cfg.proxy)
      console.log(
        dim(
          "\nThe proxy stores your Claude accounts' tokens locally and relays Claude Code's requests; Anthropic's terms forbid third parties doing that with Claude.ai credentials, so running it is your choice and your accounts' risk.",
        ),
      )
    const key = readProxyKey(defaultRunner)
    if (!cfg.proxy || !key || !(await proxyHealthy(port, key)))
      await setupProxy(port, { log: (l) => console.log(`\n${l}`) })

    if (mode === "chrome")
      console.log(
        "\nA new Chrome window (a fresh profile, deleted afterwards) opens on Claude's sign-in page. Enter the account's email, then the code Claude emails you, then authorize. This finishes on its own once you do.",
      )
    const account = await loginProxyAccount({ email: values.email, mode })

    // Re-read: the sign-in can take minutes, and another inscope command may have saved
    // the config meanwhile. Record the proxy only now that it has an account to route to.
    const latest = configExists() ? loadConfig() : cfg
    const next = { ...latest, proxy: { port } }
    saveConfig(next)
    applyAll(next)

    const n = proxyAccounts().length
    console.log(
      green(`\n✓ ${account.email} signed in`) +
        `\n  the proxy (${proxyUrl(port)}) holds ${n} account${n === 1 ? "" : "s"}; every Claude Code login goes through it` +
        `\n  Claude Code sessions started from now on use it. See the limits: ${name} usage`,
    )
    process.exit(0)
  })()
