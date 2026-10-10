import os from "node:os"
import path from "node:path"

import {
  accountDir,
  CREDENTIAL_ENV_VARS,
  type FetchLike,
  fetchUsage,
  planLabel,
  readOAuth,
  type UsageWindow,
} from "@/accounts"
import { isAccountDir } from "@/accounts"
import type { Config } from "@/config"
import { contractTilde, home } from "@/env"
import {
  baseClaudeDir,
  hasOwnLogin,
  INSCOPE_DIR,
  inscopeDirPath,
  inscopeSignedIn,
} from "@/generators/isolate"
import { type ProxyAccount, proxyAccounts, proxyUsers } from "@/proxy"
import { claudeAuthStatus, defaultRunner, type Runner } from "@/secrets"

// Every Claude login inscope knows about: the shared base, each named account, and each
// isolated workspace that has been signed in. `usedBy` is the workspaces that run on it.
export type LoginRef = {
  label: string
  kind: "base" | "account" | "isolated" | "proxy"
  dir: string
  // The CLAUDE_CONFIG_DIR value Claude runs this login with; undefined means unset, which
  // is Claude's bare default Keychain slot (a different login from `~/.claude` spelled out).
  ccd: string | undefined
  usedBy: string[]
  // A proxy account's token comes from the proxy's own auth file, not the Keychain.
  proxyAccount?: ProxyAccount
}

// The CLAUDE_CONFIG_DIR the base login actually runs with, matching the hook: once any
// workspace has its own login the hook exports the base explicitly (your own value, else
// $HOME/.claude); with none, it leaves CLAUDE_CONFIG_DIR as you set it, or unset.
export const baseCcd = (cfg: Config): string | undefined => {
  if (cfg.workspaces.some(hasOwnLogin)) return baseClaudeDir()
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  return env && path.basename(env) !== INSCOPE_DIR && !isAccountDir(env) ? env : undefined
}

export const knownLogins = (cfg: Config): LoginRef[] => {
  const out: LoginRef[] = [
    {
      label: "base",
      kind: "base",
      dir: baseCcd(cfg) ?? path.join(home(), ".claude"),
      ccd: baseCcd(cfg),
      usedBy: cfg.workspaces.filter((w) => !hasOwnLogin(w)).map((w) => w.name),
    },
  ]
  for (const acc of cfg.accounts ?? [])
    out.push({
      label: acc.name,
      kind: "account",
      dir: accountDir(acc.name),
      ccd: accountDir(acc.name),
      usedBy: cfg.workspaces.filter((w) => w.account === acc.name).map((w) => w.name),
    })
  for (const ws of cfg.workspaces)
    if (ws.isolate && inscopeSignedIn(inscopeDirPath(ws)))
      out.push({
        label: ws.name,
        kind: "isolated",
        dir: inscopeDirPath(ws),
        ccd: inscopeDirPath(ws),
        usedBy: [ws.name],
      })
  // The proxy's accounts (\`inscope proxy login\`): the proxy keeps their tokens fresh
  // itself, so their usage reads even when no session has used them for a while.
  if (cfg.proxy)
    for (const acc of proxyAccounts())
      out.push({
        label: "proxy",
        kind: "proxy",
        dir: acc.file,
        ccd: undefined,
        usedBy: proxyUsers(cfg),
        proxyAccount: acc,
      })
  return out
}

export type UsageState = "ok" | "expired" | "signed-out" | "rate-limited" | "error"

export type UsageRow = {
  label: string
  kind: LoginRef["kind"]
  dir: string
  usedBy: string[]
  email?: string
  plan?: string
  state: UsageState
  fiveHour?: UsageWindow
  week?: UsageWindow
  detail?: string
}

export type ResolveUsageOptions = {
  run?: Runner
  fetchImpl?: FetchLike
  now?: number
  // Let Claude Code revive an expired (or rejected) login by running a one-word Haiku
  // prompt on it, then read it again. inscope never refreshes a token itself: Claude
  // Code owns that single-use refresh token, and a second refresher would break the
  // login. The base login is never refreshed this way (it would add a session to your
  // own ~/.claude history); using it once does the same.
  refresh?: boolean
  onRefresh?: (label: string) => void
}

const REFRESH_PROMPT = "Reply with the single word: ok"

// Run Claude Code once on a login, with no credential overrides and from a neutral
// directory, so no project's CLAUDE.md, hooks, or MCP servers run alongside it.
export const refreshLogin = (ccd: string, run: Runner = defaultRunner): boolean =>
  run("claude", ["-p", REFRESH_PROMPT, "--model", "haiku"], {
    env: { CLAUDE_CONFIG_DIR: ccd },
    unset: CREDENTIAL_ENV_VARS,
    cwd: os.tmpdir(),
    timeoutMs: 120_000,
  }).status === 0

type Pending = {
  row: Omit<UsageRow, "state">
  login: LoginRef
  token: string
  refreshed: boolean
}

// The Keychain reads, `claude auth status`, and refreshes are blocking subprocesses, so
// they all run first; only then do the usage requests go out together, so no request's
// timeout ever runs while the event loop is blocked on a subprocess.
export const resolveUsage = async (
  cfg: Config,
  opts: ResolveUsageOptions = {},
): Promise<UsageRow[]> => {
  const run = opts.run ?? defaultRunner
  const now = opts.now ?? Date.now()
  const canRefresh = (l: LoginRef) =>
    Boolean(opts.refresh) && l.kind !== "base" && l.ccd !== undefined
  const refresh = (l: LoginRef) => {
    opts.onRefresh?.(l.label)
    refreshLogin(l.ccd!, run)
    return readOAuth(l.ccd, run)
  }

  const rows: (UsageRow | Pending)[] = knownLogins(cfg).map((login) => {
    const base = { label: login.label, kind: login.kind, dir: login.dir, usedBy: login.usedBy }
    const pa = login.proxyAccount
    let tok = pa
      ? pa.accessToken
        ? { accessToken: pa.accessToken, expiresAt: pa.expiresAt }
        : null
      : readOAuth(login.ccd, run)
    if (!tok)
      return { ...base, ...(pa ? { email: pa.email } : {}), state: "signed-out" } as UsageRow
    const email = pa ? pa.email : claudeAuthStatus(login.ccd, run).email
    const row = { ...base, email, plan: planLabel(tok) }
    const expired = (t: typeof tok) => t?.expiresAt !== undefined && t.expiresAt <= now
    let refreshed = false
    if (expired(tok) && canRefresh(login)) {
      tok = refresh(login) ?? tok
      refreshed = true
    }
    if (expired(tok)) return { ...row, state: "expired" } as UsageRow
    return { row, login, token: tok.accessToken, refreshed } satisfies Pending
  })

  const fetchAll = (pending: Pending[]) =>
    Promise.all(pending.map((p) => fetchUsage(p.token, opts.fetchImpl)))
  const toRow = (p: Pending, res: Awaited<ReturnType<typeof fetchUsage>>): UsageRow =>
    res.ok
      ? { ...p.row, state: "ok", fiveHour: res.fiveHour ?? undefined, week: res.week ?? undefined }
      : { ...p.row, state: res.reason, detail: res.detail }

  const pending = rows.filter((r): r is Pending => "token" in r)
  const results = await fetchAll(pending)
  const out = new Map<Pending, UsageRow>(pending.map((p, i) => [p, toRow(p, results[i])]))

  // A token rejected before its expiry (revoked, or refreshed elsewhere): with --refresh,
  // let Claude Code refresh it once and ask again.
  const retry: Pending[] = []
  for (const p of pending) {
    if (out.get(p)!.state !== "expired" || p.refreshed || !canRefresh(p.login)) continue
    const tok = refresh(p.login)
    if (tok) retry.push({ ...p, token: tok.accessToken, refreshed: true })
  }
  const again = await fetchAll(retry)
  retry.forEach((p, i) => {
    const orig = pending.find((x) => x.login === p.login)!
    out.set(orig, toRow(p, again[i]))
  })

  return rows.map((r) => ("token" in r ? out.get(r)! : r))
}

// "2h 05m", "3d 4h", "now", or "" when unknown. Pure (takes `now`) for the golden.
export const resetsIn = (iso: string | null | undefined, now: number): string => {
  if (!iso) return ""
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ""
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  if (mins === 0) return "now"
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`
  return `${m}m`
}

type Paint = (s: string) => string
export type UsagePainters = { head: Paint; ok: Paint; warn: Paint; bad: Paint; dim: Paint }
const PLAIN: UsagePainters = {
  head: (s) => s,
  ok: (s) => s,
  warn: (s) => s,
  bad: (s) => s,
  dim: (s) => s,
}

const pct = (w: UsageWindow | undefined, now: number) => {
  if (!w) return { text: "-", level: 0 }
  if (w.percent === null) {
    const r = resetsIn(w.resetsAt, now)
    return { text: r ? `- · ${r}` : "-", level: 0 }
  }
  const p = Math.round(w.percent)
  const r = resetsIn(w.resetsAt, now)
  return { text: `${p}%${r ? ` · ${r}` : ""}`, level: p }
}

const STATE_LABEL: Record<Exclude<UsageState, "ok">, string> = {
  expired: "expired",
  "signed-out": "signed out",
  "rate-limited": "rate limited",
  error: "unavailable",
}

// Notes printed under the table, one per state present, naming the logins it covers.
const stateNote = (state: Exclude<UsageState, "ok">, rows: UsageRow[]): string => {
  const names = rows.map((r) => r.label).join(", ")
  switch (state) {
    case "expired":
      return `expired (${names}): run \`inscope usage --refresh\`, or use that login once`
    case "signed-out":
      return `signed out (${names}): sign in with \`inscope login <name>\` (or \`claude\` there)`
    case "rate-limited":
      return `rate limited (${names}): the usage endpoint asked to slow down; try again shortly`
    case "error":
      return rows
        .map((r) => `unavailable (${r.label}): ${r.detail ?? "unknown error"}`)
        .join("\n  ")
  }
}

// Pure: same rows in, same table out (golden-pinned). Painters default to no-ops; the
// command passes real colors, which no-op when stdout is piped. Widths are measured on
// the plain text so color codes never skew the columns.
export const renderUsage = (rows: UsageRow[], now: number, c: UsagePainters = PLAIN): string => {
  const head = ["LOGIN", "EMAIL", "PLAN", "5-HOUR", "WEEKLY", "USED BY"]
  const same = (s: string) => s
  const level = (l: number) => (l >= 90 ? c.bad : l >= 70 ? c.warn : c.ok)
  const cells = rows.map((r) => {
    const used = r.usedBy.length ? r.usedBy.join(", ") : "-"
    if (r.state !== "ok") {
      const tone = r.state === "signed-out" ? c.dim : c.warn
      return {
        plain: [r.label, r.email ?? "-", r.plan ?? "-", STATE_LABEL[r.state], "-", used],
        paint: [c.head, same, same, tone, c.dim, c.dim],
      }
    }
    const five = pct(r.fiveHour, now)
    const week = pct(r.week, now)
    return {
      plain: [r.label, r.email ?? "-", r.plan ?? "-", five.text, week.text, used],
      paint: [c.head, same, same, level(five.level), level(week.level), c.dim],
    }
  })
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((x) => x.plain[i].length)))
  const line = (vals: string[], paints: Paint[]) =>
    `  ${vals.map((v, i) => paints[i](i === vals.length - 1 ? v : v.padEnd(widths[i]))).join("  ")}`.trimEnd()
  const out = [
    line(
      head,
      head.map(() => c.dim),
    ),
  ]
  for (const x of cells) out.push(line(x.plain, x.paint))
  const notes: string[] = []
  for (const state of ["expired", "signed-out", "rate-limited", "error"] as const) {
    const hit = rows.filter((r) => r.state === state)
    if (hit.length) notes.push(`  ${c.dim(stateNote(state, hit))}`)
  }
  if (notes.length) out.push("", ...notes)
  return out.join("\n")
}

export const usageJson = (rows: UsageRow[]) =>
  rows.map((r) => ({
    login: r.label,
    kind: r.kind,
    dir: contractTilde(r.dir),
    email: r.email ?? null,
    plan: r.plan ?? null,
    state: r.state,
    fiveHour: r.fiveHour ?? null,
    weekly: r.week ?? null,
    usedBy: r.usedBy,
    ...(r.detail ? { detail: r.detail } : {}),
  }))
