import fs from "node:fs"
import { parseArgs } from "node:util"

import { applyAll, preflightApply } from "@/apply"
import { configExists, isProxyPort, loadConfig, saveConfig } from "@/config"
import { contractTilde } from "@/env"
import {
  PROXY_VERSION,
  proxyAccounts,
  proxyBinPath,
  proxyConfigPath,
  proxyHealthy,
  proxyLoaded,
  proxyRoot,
  proxyUrl,
  readProxyKey,
  setupProxy,
  startProxy,
  stopProxy,
  uninstallProxy,
} from "@/proxy"
import { defaultRunner } from "@/secrets"
import { green, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Low-level controls for the local proxy that holds your Claude accounts. You
do not need these day to day: \`${name} login\` sets the proxy up, and every Claude
Code login goes through it.

Usage:
  $ ${name} proxy <command> [options]

Commands:
  status [--json]      Show whether it is running and the accounts it holds
  start | stop         Start or stop it (while it is stopped, Claude Code cannot
                       reach Anthropic)
  setup [--port <n>]   Reinstall CLIProxyAPI ${PROXY_VERSION} (checksum-verified), rewrite
                       its config, and restart it, optionally on another port
  uninstall [--purge]  Stop using the proxy: stop it, remove its agent and binary,
                       and send every login straight to Anthropic again (each
                       uses its own Claude Code sign-in); --purge also removes
                       its accounts and client key

The proxy moves a request to the next account when the current one answers that it
hit its limit, so a conversation switches accounts at the limit itself, not before.`

const requireProxy = () => {
  const cfg = configExists() ? loadConfig() : null
  if (!cfg?.proxy) {
    console.error(`The proxy is not set up. Sign an account in with \`${name} login\`.`)
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
      json: { type: "boolean" },
      purge: { type: "boolean" },
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
    const { cfg, port: current } = requireProxy()
    const port = values.port ? Number(values.port) : current
    if (!isProxyPort(port)) {
      console.error(`Invalid --port "${values.port}": use 1024-65535`)
      process.exit(1)
    }
    const next = { ...cfg, proxy: { port } }
    preflightApply(next)
    await setupProxy(port, { run, log: (l) => console.log(`\n${l}`) })
    saveConfig(next)
    // A new port moves every login's base URL with it.
    applyAll(next)
    console.log(green(`✓ proxy running on ${proxyUrl(port)} (local only), started at login`))
    process.exit(0)
  }

  if (sub === "status") {
    const { port } = requireProxy()
    const key = readProxyKey(run)
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
    }
    if (values.json) {
      console.log(JSON.stringify(snap, null, 2))
      process.exit(0)
    }
    const ok = (b: boolean, yes: string, no: string) => (b ? green(yes) : yellow(no))
    console.log(`\n  proxy    ${snap.url} · CLIProxyAPI ${snap.version}`)
    console.log(
      `  state    ${ok(snap.healthy, "running", snap.loaded ? "loaded but not answering" : "stopped")}`,
    )
    console.log(
      `  accounts ${snap.accounts.length ? snap.accounts.map((a) => `${a.email}${a.disabled ? " (disabled)" : ""}`).join(", ") : yellow(`none; run \`${name} login\``)}`,
    )
    console.log(`  config   ${contractTilde(proxyConfigPath())}`)
    process.exit(0)
  }

  if (sub === "start" || sub === "stop") {
    requireProxy()
    if (sub === "start") startProxy(run)
    else stopProxy(run)
    console.log(green(`✓ proxy ${sub === "start" ? "started" : "stopped"}`))
    if (sub === "stop")
      console.log(
        yellow(
          `  every Claude Code login goes through it, so none can reach Anthropic until \`${name} proxy start\``,
        ),
      )
    process.exit(0)
  }

  if (sub === "uninstall") {
    const { cfg } = requireProxy()
    const { proxy: _gone, ...rest } = cfg
    preflightApply(rest)
    uninstallProxy({ purge: values.purge, run })
    saveConfig(rest)
    // Clear the routing from every login, so none points at a proxy that is gone.
    applyAll(rest)
    console.log(
      green(`✓ proxy uninstalled; every login goes straight to Anthropic again`) +
        (values.purge
          ? ""
          : `\n  its accounts and config are kept in ${contractTilde(proxyRoot())}; --purge removes them`),
    )
    process.exit(0)
  }

  console.error(`unknown proxy command: ${sub}\n\n${helpMessage}`)
  process.exit(1)
}
