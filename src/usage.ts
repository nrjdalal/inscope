import {
  accountDir,
  type FetchLike,
  fetchUsage,
  planLabel,
  readOAuth,
  type UsageWindow,
} from "@/accounts"
import type { Config } from "@/config"
import { contractTilde } from "@/env"
import { baseClaudeDir, hasOwnLogin, inscopeDirPath, inscopeSignedIn } from "@/generators/isolate"
import { claudeAuthStatus, defaultRunner, type Runner } from "@/secrets"

// Every Claude login inscope knows about: the shared base, each named account, and each
// isolated workspace that has been signed in. `usedBy` is the workspaces that run on it.
export type LoginRef = {
  label: string
  kind: "base" | "account" | "isolated"
  dir: string
  usedBy: string[]
}

export const knownLogins = (cfg: Config): LoginRef[] => {
  const out: LoginRef[] = [
    {
      label: "base",
      kind: "base",
      dir: baseClaudeDir(),
      usedBy: cfg.workspaces.filter((w) => !hasOwnLogin(w)).map((w) => w.name),
    },
  ]
  for (const acc of cfg.accounts ?? [])
    out.push({
      label: acc.name,
      kind: "account",
      dir: accountDir(acc.name),
      usedBy: cfg.workspaces.filter((w) => w.account === acc.name).map((w) => w.name),
    })
  for (const ws of cfg.workspaces)
    if (ws.isolate && inscopeSignedIn(inscopeDirPath(ws)))
      out.push({ label: ws.name, kind: "isolated", dir: inscopeDirPath(ws), usedBy: [ws.name] })
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
  // Before reading usage, let Claude Code refresh an expired login by running a
  // one-word Haiku prompt on it. inscope never refreshes a token itself: Claude Code
  // owns that single-use refresh token, and a second refresher would break the login.
  refresh?: boolean
  onRefresh?: (label: string) => void
}

const REFRESH_PROMPT = "Reply with the single word: ok"

export const refreshLogin = (dir: string, run: Runner = defaultRunner): boolean =>
  run("claude", ["-p", REFRESH_PROMPT, "--model", "haiku"], {
    env: { CLAUDE_CONFIG_DIR: dir },
    timeoutMs: 120_000,
  }).status === 0

export const resolveUsage = async (
  cfg: Config,
  opts: ResolveUsageOptions = {},
): Promise<UsageRow[]> => {
  const run = opts.run ?? defaultRunner
  const now = opts.now ?? Date.now()
  return Promise.all(
    knownLogins(cfg).map(async (login): Promise<UsageRow> => {
      const base = { label: login.label, kind: login.kind, dir: login.dir, usedBy: login.usedBy }
      let tok = readOAuth(login.dir, run)
      if (!tok) return { ...base, state: "signed-out" }
      const auth = claudeAuthStatus(login.dir, run)
      const who = { email: auth.email, plan: planLabel(tok) }
      const expired = () => tok?.expiresAt !== undefined && tok.expiresAt <= now
      if (expired() && opts.refresh) {
        opts.onRefresh?.(login.label)
        refreshLogin(login.dir, run)
        tok = readOAuth(login.dir, run) ?? tok
      }
      if (expired()) return { ...base, ...who, state: "expired" }
      const res = await fetchUsage(tok.accessToken, opts.fetchImpl)
      if (res.ok)
        return {
          ...base,
          ...who,
          state: "ok",
          fiveHour: res.fiveHour ?? undefined,
          week: res.week ?? undefined,
        }
      return { ...base, ...who, state: res.reason, detail: res.detail }
    }),
  )
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
  if (!w || w.percent === null) return { text: "-", level: 0 }
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
