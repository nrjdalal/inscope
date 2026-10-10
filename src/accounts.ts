import { createHash } from "node:crypto"
import path from "node:path"

import { home, inscopeHome } from "@/env"
import { defaultRunner, type Runner } from "@/secrets"

// A named Claude login inscope keeps outside any workspace, so several workspaces can
// run on it and a workspace can move between accounts. Each account is its own Claude
// config dir; `inscope login <name>` signs it in through Claude Code's own
// `claude auth login`, and a workspace with `account: <name>` runs on it (the hook
// exports CLAUDE_CONFIG_DIR pointing here).
export type Account = { name: string; email?: string }

export const accountsRoot = () => path.join(inscopeHome(), "accounts")

export const accountDir = (name: string) => path.join(accountsRoot(), name)

// Whether `dir` is (or sits inside) one of inscope's account logins. Used to keep a
// login the hook exported from ever being mistaken for the user's own base login.
export const isAccountDir = (dir: string): boolean => {
  const root = accountsRoot()
  return dir === root || dir.startsWith(root + path.sep)
}

// Claude Code on macOS keeps each login's OAuth token in a Keychain item named after
// the LITERAL CLAUDE_CONFIG_DIR string it ran with: `Claude Code-credentials-` plus the
// first 8 hex of sha256(dir), with only NFC normalization (no realpath, no `~`
// expansion, no trailing-slash cleanup). Without CLAUDE_CONFIG_DIR it uses the bare
// `Claude Code-credentials`. So the hook must export exactly the string `inscope
// login` signed in with, or Claude reads an empty slot.
export const keychainServiceFor = (configDir: string): string =>
  `Claude Code-credentials-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`

export const BARE_KEYCHAIN_SERVICE = "Claude Code-credentials"

export type OAuthToken = {
  accessToken: string
  expiresAt?: number
  subscriptionType?: string
  rateLimitTier?: string
}

const readSlot = (service: string, run: Runner): OAuthToken | null => {
  const r = run("security", ["find-generic-password", "-s", service, "-w"])
  if (r.status !== 0 || !r.stdout.trim()) return null
  try {
    const o = JSON.parse(r.stdout)?.claudeAiOauth
    if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null
    return {
      accessToken: o.accessToken,
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : undefined,
      subscriptionType: typeof o.subscriptionType === "string" ? o.subscriptionType : undefined,
      rateLimitTier: typeof o.rateLimitTier === "string" ? o.rateLimitTier : undefined,
    }
  } catch {
    return null
  }
}

// The OAuth token Claude Code stored for a config dir, read straight from the Keychain
// (read-only: inscope never refreshes or writes it, so it can never race Claude Code's
// own refresh of a single-use refresh token). The default ~/.claude login also falls
// back to the bare slot, which Claude Code uses when CLAUDE_CONFIG_DIR is unset.
export const readOAuth = (configDir: string, run: Runner = defaultRunner): OAuthToken | null =>
  readSlot(keychainServiceFor(configDir), run) ??
  (configDir === path.join(home(), ".claude") ? readSlot(BARE_KEYCHAIN_SERVICE, run) : null)

// Anthropic's subscription usage endpoint. Undocumented (it backs Claude Code's own
// /usage view), so every field is read defensively and any surprise degrades to an
// error row instead of a crash. INSCOPE_ANTHROPIC_API_URL points it at a local
// emulator in tests.
export const anthropicApiBase = () =>
  process.env.INSCOPE_ANTHROPIC_API_URL?.trim().replace(/\/+$/, "") || "https://api.anthropic.com"

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

export const fetchUsage = async (
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<UsageFetch> => {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchImpl(`${anthropicApiBase()}/api/oauth/usage`, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    })
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

// A readable plan from what Claude Code stored with the token: the rate-limit tier
// carries the Max multiplier (`default_claude_max_20x` -> "max 20x"); otherwise the
// subscription type ("pro", "team", ...).
export const planLabel = (tok: Pick<OAuthToken, "subscriptionType" | "rateLimitTier"> | null) => {
  const tier = tok?.rateLimitTier?.match(/max_(\d+x)/)
  if (tier) return `max ${tier[1]}`
  return tok?.subscriptionType || undefined
}
