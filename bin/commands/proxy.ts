import fs from "node:fs"
import { parseArgs } from "node:util"

import { moveProxy, removeProxy } from "@/accounts"
import { configExists, isProxyPort, loadConfig } from "@/config"
import { contractTilde } from "@/env"
import {
  configPools,
  DEFAULT_POOL,
  PROXY_VERSION,
  proxyAccounts,
  proxyBinPath,
  proxyConfigPath,
  proxyHealthy,
  proxyLoaded,
  proxyRoot,
  proxyUrl,
  readProxyKey,
  startProxy,
  stopProxy,
} from "@/proxy"
import { defaultRunner } from "@/secrets"
import { green, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Low-level controls for the local proxy that holds your Claude accounts, one
proxy per pool. You do not need these day to day: \`${name} login\` sets the proxy up,
and every Claude Code login goes through it.

Usage:
  $ ${name} proxy <command> [options]

Commands:
  status [--json]      Show each pool's proxy: whether it runs, and its accounts
  start | stop         Start or stop every pool's proxy (while stopped, Claude Code
                       cannot reach Anthropic)
  setup                Reinstall CLIProxyAPI ${PROXY_VERSION} (checksum-verified), rewrite
    [--pool <name>]    the pool's config, and restart it, optionally on another port
    [--port <n>]       (default: the default pool)
  uninstall [--purge]  Stop using the proxy: stop every pool, remove their agents and
                       the binary, and send every login straight to Anthropic again
                       (each uses its own Claude Code sign-in); --purge also removes
                       the accounts and client key

The proxy moves a request to the next account in its pool when the current one
answers that it hit its limit, so a conversation switches accounts at the limit
itself, not before.`

const requireProxy = () => {
  const cfg = configExists() ? loadConfig() : null
  if (!cfg?.proxy) {
    console.error(`The proxy is not set up. Sign an account in with \`${name} login\`.`)
    process.exit(1)
  }
  return cfg
}

export const proxy = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      pool: { type: "string" },
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
    const cfg = requireProxy()
    const pool = values.pool ?? DEFAULT_POOL
    const current = configPools(cfg).find((p) => p.name === pool)
    if (!current) {
      console.error(`No pool ${pool}. See \`${name} pool list\`.`)
      process.exit(1)
    }
    const port = values.port ? Number(values.port) : current.port
    if (!isProxyPort(port)) {
      console.error(`Invalid --port "${values.port}": use 1024-65535`)
      process.exit(1)
    }
    console.log(`\nInstalling CLIProxyAPI ${PROXY_VERSION} (checksum-verified)...`)
    await moveProxy(cfg, pool, port, run)
    console.log(
      green(
        `✓ ${pool === DEFAULT_POOL ? "proxy" : `pool ${pool}`} running on ${proxyUrl(port)} (local only), started at login`,
      ),
    )
    process.exit(0)
  }

  if (sub === "status") {
    const cfg = requireProxy()
    const key = readProxyKey(run)
    const pools = await Promise.all(
      configPools(cfg).map(async (p) => ({
        pool: p.name,
        url: proxyUrl(p.port),
        loaded: proxyLoaded(run, p.name),
        healthy: key ? await proxyHealthy(p.port, key) : false,
        config: contractTilde(proxyConfigPath(p.name)),
        accounts: proxyAccounts(p.name).map((a) => ({
          email: a.email,
          disabled: a.disabled,
          tokenExpires: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
        })),
      })),
    )
    if (values.json) {
      const installed = fs.existsSync(proxyBinPath())
      console.log(JSON.stringify({ version: PROXY_VERSION, installed, pools }, null, 2))
      process.exit(0)
    }
    const ok = (b: boolean, yes: string, no: string) => (b ? green(yes) : yellow(no))
    console.log(`\n  CLIProxyAPI ${PROXY_VERSION}`)
    for (const p of pools) {
      console.log(`\n  ${p.pool === DEFAULT_POOL ? "default pool" : `pool ${p.pool}`}  ${p.url}`)
      console.log(
        `  state    ${ok(p.healthy, "running", p.loaded ? "loaded but not answering" : "stopped")}`,
      )
      console.log(
        `  accounts ${p.accounts.length ? p.accounts.map((a) => `${a.email}${a.disabled ? " (disabled)" : ""}`).join(", ") : yellow(`none; run \`${name} login${p.pool === DEFAULT_POOL ? "" : ` --pool ${p.pool}`}\``)}`,
      )
      console.log(`  config   ${p.config}`)
    }
    process.exit(0)
  }

  if (sub === "start" || sub === "stop") {
    const cfg = requireProxy()
    for (const p of configPools(cfg)) {
      if (sub === "start") startProxy(run, { pool: p.name })
      else stopProxy(run, { pool: p.name })
    }
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
    const cfg = requireProxy()
    await removeProxy(cfg, { purge: values.purge, run })
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
