import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { parseArgs } from "node:util"

import { configExists, defaultConfig, loadConfig, saveConfig } from "@/config"
import { contractTilde } from "@/env"
import {
  DEFAULT_PROXY_PORT,
  ensureProxyKey,
  installProxy,
  launchAgentPath,
  loginProxyAccount,
  logoutProxyAccount,
  PROXY_KEYCHAIN,
  PROXY_VERSION,
  proxyAccounts,
  proxyBinPath,
  proxyHealthy,
  proxyLoaded,
  proxyRoot,
  proxyUrl,
  proxyUsers,
  startProxy,
  stopProxy,
  writeProxyFiles,
} from "@/proxy"
import { defaultRunner } from "@/secrets"
import { green, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Run a local CLIProxyAPI that holds several Claude accounts, so a workspace's
conversation carries on when one account hits its limit: the proxy retries the request
on the next account, and the conversation stays there. Point a workspace at it with
\`${name} add <path> --proxy\`.

Usage:
  $ ${name} proxy <command> [options]

Commands:
  setup [--port <n>]   Install CLIProxyAPI ${PROXY_VERSION} (checksum-verified), write a
                       hardened local-only config, and run it at login (launchd)
  login [--email <e>]  Sign a Claude account in to the proxy (you sign in, in a new
                       Chrome window on a fresh profile)
  logout <email>       Remove an account from the proxy
  status [--json]      Show whether it is running, its accounts, and who uses it
  start | stop         Start or stop the proxy
  uninstall [--purge]  Stop it and remove the agent and binary; --purge also removes
                       its accounts and client key

Anthropic's terms forbid third parties that store or intermediate Claude.ai
credentials, which is what a proxy like this does: running it is your choice and
your accounts' risk.`

const requireProxy = () => {
  const cfg = configExists() ? loadConfig() : null
  if (!cfg?.proxy) {
    console.error(`The proxy is not set up. Run \`${name} proxy setup\` first.`)
    process.exit(1)
  }
  return { cfg, port: cfg.proxy.port }
}

export const proxy = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      email: { type: "string" },
      browser: { type: "string" },
      json: { type: "boolean" },
      purge: { type: "boolean" },
      force: { type: "boolean" },
    },
    args,
  })
  const sub = positionals[0]
  if (values.help || !sub) {
    console.log(helpMessage)
    process.exit(sub || values.help ? 0 : 1)
  }
  const run = defaultRunner

  if (sub === "setup") {
    const cfg = configExists() ? loadConfig() : defaultConfig()
    const port = values.port ? Number(values.port) : (cfg.proxy?.port ?? DEFAULT_PROXY_PORT)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      console.error(`Invalid --port "${values.port}": use 1024-65535`)
      process.exit(1)
    }
    console.log(`\nInstalling CLIProxyAPI ${PROXY_VERSION} (checksum-verified)...`)
    const bin = await installProxy({ run })
    const key = ensureProxyKey(run)
    writeProxyFiles(port, key, bin)
    startProxy(run)
    if (!(await proxyHealthy(port, key, { waitMs: 15_000 }))) {
      console.error(
        `The proxy did not come up on ${proxyUrl(port)}; see ${contractTilde(`${proxyRoot()}/proxy.log`)}. Is the port in use? Try --port.`,
      )
      process.exit(1)
    }
    saveConfig({ ...cfg, proxy: { port } })
    console.log(green(`✓ proxy running on ${proxyUrl(port)} (local only), started at login`))
    console.log(
      `  client key in the Keychain (${PROXY_KEYCHAIN}); config ${contractTilde(`${proxyRoot()}/config.yaml`)}`,
    )
    console.log(
      `\nNext: \`${name} proxy login\` for each account, then \`${name} add <path> --proxy\`.`,
    )
    process.exit(0)
  }

  if (sub === "login") {
    requireProxy()
    const mode = values.browser ?? "chrome"
    if (!["chrome", "system", "none"].includes(mode)) {
      console.error(`Invalid --browser "${values.browser}": use chrome, system, none`)
      process.exit(1)
    }
    const account = await loginProxyAccount({
      email: values.email,
      openUrl:
        mode === "chrome"
          ? undefined
          : mode === "system"
            ? (url) => spawnSync("open", [url], { stdio: "ignore" })
            : (url) => console.log(`Open this URL to sign in:\n${url}`),
    })
    console.log(green(`\n✓ ${account.email} signed in to the proxy`))
    const n = proxyAccounts().length
    console.log(`  the proxy now holds ${n} account${n === 1 ? "" : "s"}`)
    process.exit(0)
  }

  if (sub === "logout") {
    requireProxy()
    const email = positionals[1]
    if (!email) {
      console.error(`Usage: ${name} proxy logout <email>`)
      process.exit(1)
    }
    if (!logoutProxyAccount(email)) {
      console.error(`No proxy account ${email}. See \`${name} proxy status\`.`)
      process.exit(1)
    }
    console.log(green(`✓ removed ${email} from the proxy`))
    process.exit(0)
  }

  if (sub === "status") {
    const { cfg, port } = requireProxy()
    const key =
      run("security", ["find-generic-password", "-s", PROXY_KEYCHAIN, "-w"]).stdout.trim() || ""
    const snap = {
      version: PROXY_VERSION,
      installed: fs.existsSync(proxyBinPath()),
      loaded: proxyLoaded(run),
      healthy: key ? await proxyHealthy(port, key) : false,
      url: proxyUrl(port),
      accounts: proxyAccounts().map((a) => ({
        email: a.email,
        disabled: a.disabled,
        tokenExpires: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
      })),
      usedBy: proxyUsers(cfg),
    }
    if (values.json) {
      console.log(JSON.stringify(snap, null, 2))
      process.exit(0)
    }
    const ok = (b: boolean, yes: string, no: string) => (b ? green(yes) : yellow(no))
    console.log(`\n  proxy   ${snap.url} · CLIProxyAPI ${snap.version}`)
    console.log(
      `  state   ${ok(snap.healthy, "running", snap.loaded ? "loaded but not answering" : "stopped")}`,
    )
    console.log(
      `  accounts ${snap.accounts.length ? snap.accounts.map((a) => `${a.email}${a.disabled ? " (disabled)" : ""}`).join(", ") : yellow(`none; run \`${name} proxy login\``)}`,
    )
    console.log(`  used by ${snap.usedBy.length ? snap.usedBy.join(", ") : "no workspace yet"}`)
    process.exit(0)
  }

  if (sub === "start" || sub === "stop") {
    requireProxy()
    if (sub === "start") startProxy(run)
    else stopProxy(run)
    console.log(green(`✓ proxy ${sub === "start" ? "started" : "stopped"}`))
    process.exit(0)
  }

  if (sub === "uninstall") {
    const { cfg } = requireProxy()
    const users = proxyUsers(cfg)
    if (users.length && !values.force) {
      console.error(
        `The proxy is used by ${users.join(", ")}; move them off it first (\`${name} add <path> --no-proxy\`), or pass --force. Nothing was changed.`,
      )
      process.exit(1)
    }
    stopProxy(run)
    fs.rmSync(launchAgentPath(), { force: true })
    fs.rmSync(`${proxyRoot()}/bin`, { recursive: true, force: true })
    if (values.purge) {
      fs.rmSync(proxyRoot(), { recursive: true, force: true })
      run("security", ["delete-generic-password", "-s", PROXY_KEYCHAIN])
    }
    const { proxy: _gone, ...rest } = cfg
    saveConfig(rest)
    console.log(
      green(`✓ proxy uninstalled`) +
        (values.purge
          ? ""
          : `\n  its accounts and config are kept in ${contractTilde(proxyRoot())}; --purge removes them`),
    )
    process.exit(0)
  }

  console.error(`unknown proxy command: ${sub}\n\n${helpMessage}`)
  process.exit(1)
}
