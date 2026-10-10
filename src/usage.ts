import type { Config } from "@/config"
import { contractTilde } from "@/env"
import { poolAccounts } from "@/proxy"

// Your Claude accounts' subscription limits: each account in the proxy (`inscope
// login`), its plan, and its 5-hour and weekly usage. Read with the account's own token
// from the proxy's auth file, which the proxy keeps fresh; inscope never refreshes it.

// Anthropic's subscription endpoints. Undocumented (they back Claude Code's own /usage
// and account views), so every field is read defensively and any surprise degrades to
// an error row instead of a crash. INSCOPE_ANTHROPIC_API_URL points them at a local
// emulator in tests, and is honored only for a loopback host: each account's bearer
// token goes to this URL, so a stray override must never send them off the machine.
const ANTHROPIC_API = "https://api.anthropic.com"

export const anthropicApiBase = () => {
  const raw = process.env.INSCOPE_ANTHROPIC_API_URL?.trim()
  if (!raw) return ANTHROPIC_API
  try {
    const u = new URL(raw)
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    if (loopback && (u.protocol === "http:" || u.protocol === "https:"))
      return raw.replace(/\/+$/, "")
  } catch {}
  return ANTHROPIC_API
}

export type UsageWindow = { percent: number | null; resetsAt: string | null }

export type UsageFetch =
  | { ok: true; fiveHour: UsageWindow | null; week: UsageWindow | null }
  | { ok: false; reason: "expired" | "rate-limited" | "error"; detail: string }

const toWindow = (w: unknown): UsageWindow | null => {
  if (!w || typeof w !== "object") return null
  const o = w as Record<string, unknown>
  const pct =
    typeof o.utilization === "number" && Number.isFinite(o.utilization) ? o.utilization : null
  const at = typeof o.resets_at === "string" && o.resets_at ? o.resets_at : null
  return pct === null && at === null ? null : { percent: pct, resetsAt: at }
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number
  json: () => Promise<unknown>
}>

// One of the account endpoints, with the account's token and the OAuth beta they need.
const oauthGet = (endpoint: "usage" | "profile", token: string, fetchImpl: FetchLike) =>
  fetchImpl(`${anthropicApiBase()}/api/oauth/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  })

export const fetchUsage = async (
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<UsageFetch> => {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await oauthGet("usage", token, fetchImpl)
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      detail: `request failed: ${err instanceof Error ? err.message : err}`,
    }
  }
  if (res.status === 401) return { ok: false, reason: "expired", detail: "token rejected (401)" }
  if (res.status === 429)
    return { ok: false, reason: "rate-limited", detail: "usage endpoint rate limited (429)" }
  if (res.status !== 200)
    return { ok: false, reason: "error", detail: `usage endpoint returned ${res.status}` }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: "error", detail: "usage endpoint returned invalid JSON" }
  }
  if (!body || typeof body !== "object")
    return { ok: false, reason: "error", detail: "usage endpoint returned an unexpected shape" }
  const b = body as Record<string, unknown>
  const fiveHour = toWindow(b.five_hour)
  const week = toWindow(b.seven_day)
  if (!fiveHour && !week)
    return { ok: false, reason: "error", detail: "usage endpoint returned no 5h or weekly window" }
  return { ok: true, fiveHour, week }
}

// A readable plan from the account's profile: the rate-limit tier carries the Max
// multiplier (`default_claude_max_20x` -> "max 20x"); otherwise the organization type
// without its prefix (`claude_pro` -> "pro").
export const planLabel = (p: { rateLimitTier?: string; organizationType?: string } | null) => {
  const tier = p?.rateLimitTier?.match(/max_(\d+x)/)
  if (tier) return `max ${tier[1]}`
  return p?.organizationType?.replace(/^claude_/, "") || undefined
}

// The account's plan, from the profile endpoint behind Claude Code's own account view
// (undocumented, read defensively like the usage endpoint). Undefined when it cannot
// be read: the plan is a label, never a reason to fail the row.
export const fetchPlan = async (
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string | undefined> => {
  try {
    const res = await oauthGet("profile", token, fetchImpl)
    if (res.status !== 200) return undefined
    const org = ((await res.json()) as Record<string, any> | null)?.organization
    return planLabel({
      rateLimitTier: typeof org?.rate_limit_tier === "string" ? org.rate_limit_tier : undefined,
      organizationType:
        typeof org?.organization_type === "string" ? org.organization_type : undefined,
    })
  } catch {
    return undefined
  }
}

export type UsageState = "ok" | "expired" | "signed-out" | "rate-limited" | "error"

export type UsageRow = {
  // The pool holding the account ("default" for the default pool).
  pool: string
  email: string
  // The account's auth file in the proxy.
  file: string
  disabled: boolean
  plan?: string
  state: UsageState
  fiveHour?: UsageWindow
  week?: UsageWindow
  detail?: string
}

// One row per account, pool by pool; none until the proxy is set up. The usage and
// profile requests all go out together.
export const resolveUsage = async (
  cfg: Config,
  opts: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<UsageRow[]> => {
  const now = opts.now ?? Date.now()
  return Promise.all(
    poolAccounts(cfg).map(async ({ pool, account: acc }): Promise<UsageRow> => {
      const base = { pool, email: acc.email, file: acc.file, disabled: acc.disabled }
      if (!acc.accessToken) return { ...base, state: "signed-out" }
      if (acc.expiresAt !== undefined && acc.expiresAt <= now) return { ...base, state: "expired" }
      const [usage, plan] = await Promise.all([
        fetchUsage(acc.accessToken, opts.fetchImpl),
        fetchPlan(acc.accessToken, opts.fetchImpl),
      ])
      const row = { ...base, plan }
      return usage.ok
        ? {
            ...row,
            state: "ok",
            fiveHour: usage.fiveHour ?? undefined,
            week: usage.week ?? undefined,
          }
        : { ...row, state: usage.reason, detail: usage.detail }
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

// Notes printed under the table, one per state present, naming the accounts it covers.
const stateNote = (state: Exclude<UsageState, "ok">, rows: UsageRow[]): string => {
  const names = rows.map((r) => r.email).join(", ")
  switch (state) {
    case "expired":
      return `expired (${names}): the proxy renews tokens on its own; if this stays, sign in again with \`inscope login\``
    case "signed-out":
      return `signed out (${names}): sign in again with \`inscope login\``
    case "rate-limited":
      return `rate limited (${names}): the usage endpoint asked to slow down; try again shortly`
    case "error":
      return rows
        .map((r) => `unavailable (${r.email}): ${r.detail ?? "unknown error"}`)
        .join("\n  ")
  }
}

// Pure: same rows in, same table out (golden-pinned). Painters default to no-ops; the
// command passes real colors, which no-op when stdout is piped. Widths are measured on
// the plain text so color codes never skew the columns.
export const renderUsage = (rows: UsageRow[], now: number, c: UsagePainters = PLAIN): string => {
  // The POOL column appears once there is more than the default pool.
  const pooled = rows.some((r) => r.pool !== rows[0]?.pool)
  const head = [...(pooled ? ["POOL"] : []), "ACCOUNT", "PLAN", "5-HOUR", "WEEKLY"]
  const lead = (r: UsageRow) => (pooled ? [r.pool] : [])
  const leadPaint = pooled ? [c.dim] : []
  const same = (s: string) => s
  const level = (l: number) => (l >= 90 ? c.bad : l >= 70 ? c.warn : c.ok)
  const cells = rows.map((r) => {
    const who = r.disabled ? `${r.email} (disabled)` : r.email
    if (r.state !== "ok") {
      const tone = r.state === "signed-out" ? c.dim : c.warn
      return {
        plain: [...lead(r), who, r.plan ?? "-", STATE_LABEL[r.state], "-"],
        paint: [...leadPaint, c.head, same, tone, c.dim],
      }
    }
    const five = pct(r.fiveHour, now)
    const week = pct(r.week, now)
    return {
      plain: [...lead(r), who, r.plan ?? "-", five.text, week.text],
      paint: [...leadPaint, c.head, same, level(five.level), level(week.level)],
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
    pool: r.pool,
    email: r.email,
    file: contractTilde(r.file),
    disabled: r.disabled,
    plan: r.plan ?? null,
    state: r.state,
    fiveHour: r.fiveHour ?? null,
    weekly: r.week ?? null,
    ...(r.detail ? { detail: r.detail } : {}),
  }))
