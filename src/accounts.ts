import fs from "node:fs"

import { applyAll, preflightApply } from "@/apply"
import {
  type Config,
  type Workspace,
  configExists,
  defaultConfig,
  loadConfig,
  poolNameError,
  saveConfig,
} from "@/config"
import { contractTilde } from "@/env"
import type { BrowserMode } from "@/login"
import {
  configPools,
  DEFAULT_POOL,
  DEFAULT_PROXY_PORT,
  loginProxyAccount,
  logoutProxyAccount,
  nextPoolPort,
  poolAccounts,
  poolDir,
  poolFlag,
  poolPort,
  poolUsers,
  type ProxyAccount,
  proxyAccounts,
  proxyHealthy,
  proxyUrl,
  readProxyKey,
  retireProxyAgent,
  setupProxy,
  uninstallProxy,
} from "@/proxy"
import { defaultRunner, type Runner } from "@/secrets"

// Your Claude accounts, as inscope's config sees them: signing one in to a pool of the
// proxy, signing one out, a workspace's pool, and moving or removing the proxy. Every
// change is checked against the config it leads to before anything is touched, then
// saved and applied, so every login always points at a proxy that runs (or straight at
// Anthropic once there is none).

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
  // The pool to sign in to (default: the default pool); a new one is created.
  pool?: string
  // The port for a new pool; refused when it differs from a running one.
  port?: number
  log?: (line: string) => void
  run?: Runner
}

// The config with `pool` recorded on `port`.
const withPool = (cfg: Config, pool: string, port: number): Config =>
  pool === DEFAULT_POOL
    ? { ...cfg, proxy: { port } }
    : {
        ...cfg,
        pools: [...(cfg.pools ?? []).filter((p) => p.name !== pool), { name: pool, port }].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      }

// Remove a named pool's proxy entirely: its agent and its dir (config, auth, log).
const dropPool = (pool: string, run: Runner) => {
  // The default pool's dir is the proxy root (the binary and every pool): never this way.
  if (pool === DEFAULT_POOL) throw new Error("the default pool is removed by proxy uninstall")
  retireProxyAgent(run, pool)
  fs.rmSync(poolDir(pool), { recursive: true, force: true })
}

// Sign a Claude account in to a pool of the proxy, setting that pool's proxy up first
// when it is not running. A pool is recorded, and its logins routed to it, only once it
// holds an account: a first sign-in that fails leaves no pool behind. An account lives
// in exactly one pool (two proxies refreshing one single-use refresh token would break
// the login), so one that another pool already holds is removed again.
export const signIn = async (
  opts: SignInOptions,
): Promise<{ account: ProxyAccount; pool: string; port: number; accounts: number }> => {
  const run = opts.run ?? defaultRunner
  const log = opts.log ?? ((l: string) => console.log(l))
  const cfg = configExists() ? loadConfig() : defaultConfig()
  const pool = opts.pool ?? DEFAULT_POOL
  if (pool !== DEFAULT_POOL) {
    const nameErr = poolNameError(pool)
    if (nameErr) throw new Error(`Invalid pool "${pool}": ${nameErr}`)
    if (!cfg.proxy)
      throw new Error(
        "Sign an account in to the default pool first (`inscope login`): the shared login and every other workspace use it.",
      )
  }
  const existing = poolPort(cfg, pool)
  if (existing !== undefined && opts.port !== undefined && opts.port !== existing)
    throw new Error(
      `Pool ${pool} already runs on port ${existing}; change it with \`inscope proxy setup${poolFlag(pool)} --port ${opts.port}\`.`,
    )
  if (
    existing === undefined &&
    opts.port !== undefined &&
    configPools(cfg).some((p) => p.port === opts.port)
  )
    throw new Error(`Port ${opts.port} is already used by another pool; pick another.`)
  const port =
    existing ?? opts.port ?? (pool === DEFAULT_POOL ? DEFAULT_PROXY_PORT : await nextPoolPort(cfg))
  const fresh = existing === undefined
  // A new named pool starts empty. Files an earlier pool of that name left (from an
  // uninstall without --purge, or a sign-in cut short) would hand it accounts the config
  // does not know, maybe ones another pool holds. (The default pool keeps its accounts
  // across an uninstall instead: that also drops every named pool, so none is doubled.)
  if (fresh && pool !== DEFAULT_POOL && fs.existsSync(poolDir(pool))) {
    log(`\nRemoving files an earlier pool ${pool} left in ${contractTilde(poolDir(pool))}.`)
    dropPool(pool, run)
  }
  // Routing every login through its pool must be possible before anyone signs in: a
  // settings.json with a key helper of its own stops here, not after the sign-in.
  preflightApply(withPool(cfg, pool, port))

  if (!cfg.proxy)
    log(
      "\nThe proxy stores your Claude accounts' tokens locally and relays Claude Code's requests; Anthropic's terms forbid third parties doing that with Claude.ai credentials, so running it is your choice and your accounts' risk.",
    )
  let account: ProxyAccount
  let latest: Config = cfg
  try {
    const key = readProxyKey(run)
    if (fresh || !key || !(await proxyHealthy(port, key)))
      await setupProxy(port, { run, pool, log: (l) => log(`\n${l}`) })
    account = await loginProxyAccount({ email: opts.email, mode: opts.mode, pool, log })
    // Re-read: the sign-in can take minutes, and another inscope command may have saved
    // the config (a pool, an account) meanwhile.
    latest = configExists() ? loadConfig() : cfg
    const elsewhere = poolAccounts(latest).find(
      (a) => a.pool !== pool && a.account.email.toLowerCase() === account.email.toLowerCase(),
    )
    if (elsewhere) {
      logoutProxyAccount(account.email, pool)
      throw new Error(
        `${account.email} is already in pool ${elsewhere.pool}, and an account lives in one pool only; removed it from ${pool}. To move it, \`inscope logout ${account.email}\` first.`,
      )
    }
  } catch (err) {
    // Nothing routes to a new pool yet, so a setup or sign-in that fails leaves none
    // running (launchd would otherwise keep restarting it, and start it at every login).
    // The default pool keeps its binary and key for the next try.
    if (fresh) {
      if (pool === DEFAULT_POOL) retireProxyAgent(run)
      else dropPool(pool, run)
    }
    throw err
  }

  try {
    await reconfigure(withPool(latest, pool, port), () => {})
  } catch (err) {
    // The account is in, but the config changed under the sign-in so that this pool no
    // longer fits it (another sign-in took its port, or the proxy was uninstalled). A new
    // pool goes again, so nothing unrecorded keeps running.
    const why = err instanceof Error ? err.message : err
    if (fresh && pool !== DEFAULT_POOL) {
      dropPool(pool, run)
      throw new Error(
        `${account.email} signed in, but pool ${pool} could not be recorded (${why}), so it was removed again; sign in again.`,
      )
    }
    throw new Error(
      `${account.email} signed in to pool ${pool}, but the config could not record it: ${why}\nIts proxy runs on ${proxyUrl(port)} with files in ${contractTilde(poolDir(pool))}; sign in again once the config is fixed.`,
    )
  }
  return { account, pool, port, accounts: proxyAccounts(pool).length }
}

// Reinstall a pool's proxy and restart it, on `port`; every login on that pool moves
// with it. When it does not come up there, it is set up again where it was, so the
// logins (which still point at the old port) keep working.
export const moveProxy = (cfg: Config, pool: string, port: number, run: Runner = defaultRunner) => {
  const from = poolPort(cfg, pool)
  if (from === undefined) throw new Error(`No pool ${pool}. See \`inscope pool list\`.`)
  if (port !== from && configPools(cfg).some((p) => p.port === port))
    throw new Error(`Port ${port} is already used by another pool; pick another.`)
  return reconfigure(withPool(cfg, pool, port), async () => {
    try {
      await setupProxy(port, { run, pool })
    } catch (err) {
      if (from === port) throw err
      try {
        await setupProxy(from, { run, pool })
      } catch (again) {
        throw new Error(
          `${err instanceof Error ? err.message : err}\nPutting it back on port ${from} failed too: ${again instanceof Error ? again.message : again}`,
        )
      }
      throw err
    }
  })
}

// A workspace's pool once `add`/`edit` change it: `want` names a pool ("default"
// clears it), else the workspace keeps its pool, which needs an isolated config (only
// that has settings of its own to route), so it is dropped, with a note, without one.
export const poolAfterChange = (
  cfg: Config | null | undefined,
  prior: Workspace | undefined,
  isolate: boolean,
  want?: string,
): { pool: string | undefined; note?: string } => {
  if (want === DEFAULT_POOL) return { pool: undefined }
  if (want !== undefined) {
    if (!cfg?.pools?.some((p) => p.name === want))
      throw new Error(
        `No pool ${want}. Create it by signing an account in to it: inscope login --pool ${want}`,
      )
    return { pool: want }
  }
  if (!prior?.pool) return { pool: undefined }
  if (isolate) return { pool: prior.pool }
  return {
    pool: undefined,
    note: `Note: this workspace left pool ${prior.pool}; a pool needs a separate Claude config, so it uses the default pool now.`,
  }
}

// "a", "a and b", "a, b, and c"
const listOf = (items: string[]) =>
  items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`

// Remove an account from whichever pool holds it. A pool's last account is refused while
// a login uses that pool (the default pool always: the shared login runs on it), since
// that login would have no account; the last account of an unused named pool takes the
// pool with it.
export const signOut = async (
  cfg: Config,
  email: string,
  run: Runner = defaultRunner,
): Promise<{ pool: string; poolRemoved: boolean }> => {
  const all = poolAccounts(cfg)
  const hit = all.find((a) => a.account.email.toLowerCase() === email.toLowerCase())
  if (!hit)
    throw new Error(
      `No account ${email} in the proxy.${all.length ? ` It holds: ${all.map((a) => a.account.email).join(", ")}.` : " Sign one in with `inscope login`."}`,
    )
  const { pool } = hit
  const last = proxyAccounts(pool).length === 1
  const users = poolUsers(cfg, pool)
  if (last && users.length)
    throw new Error(
      `${email} is the last account in pool ${pool}, which ${listOf(users)} ${users.length === 1 ? "uses" : "use"}; removing it would leave ${users.length === 1 ? "that login" : "them"} with no account. Sign another in first (\`inscope login${poolFlag(pool)}\`)${pool === DEFAULT_POOL ? ", or stop using the proxy with `inscope proxy uninstall`" : `, or move ${users.length === 1 ? "it" : "them"} to another pool`}. Nothing was changed.`,
    )
  if (!last) {
    logoutProxyAccount(email, pool)
    return { pool, poolRemoved: false }
  }
  const { pools, ...rest } = cfg
  const left = (pools ?? []).filter((p) => p.name !== pool)
  await reconfigure(left.length ? { ...rest, pools: left } : rest, () => dropPool(pool, run))
  return { pool, poolRemoved: true }
}

// Stop using the proxy: remove every pool (with `purge`, the accounts and key too), and
// send every login straight to Anthropic again. Workspaces lose their pool.
export const removeProxy = (cfg: Config, opts: { purge?: boolean; run?: Runner } = {}) => {
  const pools = configPools(cfg).map((p) => p.name)
  const { proxy: _proxy, pools: _pools, ...rest } = cfg
  const next = {
    ...rest,
    workspaces: rest.workspaces.map(({ pool: _pool, ...w }) => w),
  }
  return reconfigure(next, () => uninstallProxy({ ...opts, pools }))
}
