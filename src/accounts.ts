import { applyAll, preflightApply } from "@/apply"
import { type Config, configExists, defaultConfig, loadConfig, saveConfig } from "@/config"
import type { BrowserMode } from "@/login"
import {
  DEFAULT_PROXY_PORT,
  loginProxyAccount,
  logoutProxyAccount,
  type ProxyAccount,
  proxyAccounts,
  proxyHealthy,
  readProxyKey,
  retireProxyAgent,
  setupProxy,
  uninstallProxy,
} from "@/proxy"
import { defaultRunner, type Runner } from "@/secrets"

// Your Claude accounts, as inscope's config sees them: signing one in to the proxy, and
// moving or removing the proxy. Every change is checked against the config it leads to
// before anything is touched, then saved and applied, so every login always points at a
// proxy that runs (or straight at Anthropic once there is none).

// Check the config a change leads to, make the change, then save and apply that config.
const reconfigure = async (next: Config, change: () => unknown) => {
  preflightApply(next)
  await change()
  saveConfig(next)
  applyAll(next)
}

export type SignInOptions = {
  email?: string
  mode: BrowserMode
  // The port for a new proxy; refused when it differs from a running one.
  port?: number
  log?: (line: string) => void
  run?: Runner
}

// Sign a Claude account in to the proxy, setting the proxy up first when it is not
// running. The proxy is recorded, and every login routed to it, only once it holds an
// account; a first sign-in that fails leaves no proxy behind.
export const signIn = async (
  opts: SignInOptions,
): Promise<{ account: ProxyAccount; port: number; accounts: number }> => {
  const run = opts.run ?? defaultRunner
  const log = opts.log ?? ((l: string) => console.log(l))
  const cfg = configExists() ? loadConfig() : defaultConfig()
  if (cfg.proxy && opts.port !== undefined && opts.port !== cfg.proxy.port)
    throw new Error(
      `The proxy already runs on port ${cfg.proxy.port}; change it with \`inscope proxy setup --port ${opts.port}\`.`,
    )
  const port = cfg.proxy?.port ?? opts.port ?? DEFAULT_PROXY_PORT
  // Routing every login through the proxy must be possible before anyone signs in: a
  // settings.json with a key helper of its own stops here, not after the sign-in.
  preflightApply({ ...cfg, proxy: { port } })

  if (!cfg.proxy)
    log(
      "\nThe proxy stores your Claude accounts' tokens locally and relays Claude Code's requests; Anthropic's terms forbid third parties doing that with Claude.ai credentials, so running it is your choice and your accounts' risk.",
    )
  let account: ProxyAccount
  try {
    const key = readProxyKey(run)
    if (!cfg.proxy || !key || !(await proxyHealthy(port, key)))
      await setupProxy(port, { run, log: (l) => log(`\n${l}`) })
    account = await loginProxyAccount({ email: opts.email, mode: opts.mode, log })
  } catch (err) {
    // Nothing routes to a first proxy yet, so a setup or sign-in that fails leaves none
    // running (launchd would otherwise keep restarting it, and start it at every login).
    // The binary and key stay for the next try.
    if (!cfg.proxy) retireProxyAgent(run)
    throw err
  }

  // Re-read: the sign-in can take minutes, and another inscope command may have saved
  // the config meanwhile.
  const latest = configExists() ? loadConfig() : cfg
  await reconfigure({ ...latest, proxy: { port } }, () => {})
  return { account, port, accounts: proxyAccounts().length }
}

// Reinstall the proxy and restart it, on `port`; every login's URL moves with it. When
// it does not come up there, it is set up again where it was, so the logins (which still
// point at the old port) keep working.
export const moveProxy = (cfg: Config, port: number, run: Runner = defaultRunner) => {
  const from = cfg.proxy?.port
  return reconfigure({ ...cfg, proxy: { port } }, async () => {
    try {
      await setupProxy(port, { run })
    } catch (err) {
      if (from === undefined || from === port) throw err
      try {
        await setupProxy(from, { run })
      } catch (again) {
        throw new Error(
          `${err instanceof Error ? err.message : err}\nPutting it back on port ${from} failed too: ${again instanceof Error ? again.message : again}`,
        )
      }
      throw err
    }
  })
}

// Remove an account from the proxy. The last one is refused: every login goes through the
// proxy, so it would leave Claude Code with no account (removeProxy stops using it).
export const signOut = (email: string): void => {
  const accounts = proxyAccounts()
  if (!accounts.some((a) => a.email.toLowerCase() === email.toLowerCase()))
    throw new Error(
      `No account ${email} in the proxy.${accounts.length ? ` It holds: ${accounts.map((a) => a.email).join(", ")}.` : " Sign one in with `inscope login`."}`,
    )
  if (accounts.length === 1)
    throw new Error(
      `${email} is the proxy's last account, and every Claude Code login goes through the proxy, so removing it would leave Claude Code with no account. Sign another in first (\`inscope login\`), or stop using the proxy with \`inscope proxy uninstall\`. Nothing was changed.`,
    )
  logoutProxyAccount(email)
}

// Stop using the proxy: remove it (with `purge`, its accounts and key too), and send
// every login straight to Anthropic again.
export const removeProxy = (cfg: Config, opts: { purge?: boolean; run?: Runner } = {}) => {
  const { proxy: _gone, ...rest } = cfg
  return reconfigure(rest, () => uninstallProxy(opts))
}
