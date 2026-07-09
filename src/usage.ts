import fs from "node:fs"
import path from "node:path"

import { accountDir } from "@/env"

// Detect whether a Claude account is currently usage-limit-capped, and until when,
// from what Claude Code writes on disk. On a real usage-limit hit it appends a
// transcript line with `"isApiErrorMessage": true` whose text is
// `Claude AI usage limit reached|<unix_seconds>`; the digits are the exact reset
// epoch. Each account is its own CLAUDE_CONFIG_DIR, so its transcripts under
// `<accountDir>/projects/**/*.jsonl` are that account's own usage. Pure fs; no
// Runner, and never run from the chpwd hook (only status/switch/MCP).

export type AccountCap = { capped: boolean; resetAt?: number }

const MARKER = "Claude AI usage limit reached|"
const RESET_RE = /Claude AI usage limit reached\|(\d+)/

// Collect *.jsonl under `<root>/projects`, newest-mtime first, bounded so a large
// history stays cheap to scan.
const sessionFiles = (root: string, limit = 40): string[] => {
  const found: { file: string; mtime: number }[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          found.push({ file: p, mtime: fs.statSync(p).mtimeMs })
        } catch {}
      }
    }
  }
  walk(path.join(root, "projects"))
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.file)
}

// The latest usage-limit reset epoch (seconds) across an account's transcripts, or
// undefined if it never hit a limit. Requires the marker AND `isApiErrorMessage` on
// the same line (Claude Code's real limit entry), so a user message quoting the
// text can't trip it.
const latestResetEpoch = (accountRoot: string): number | undefined => {
  let latest: number | undefined
  for (const file of sessionFiles(accountRoot)) {
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    if (!text.includes(MARKER)) continue
    for (const line of text.split("\n")) {
      if (!line.includes("isApiErrorMessage") || !line.includes(MARKER)) continue
      const m = RESET_RE.exec(line)
      if (!m) continue
      const epoch = Number(m[1])
      if (Number.isFinite(epoch) && (latest === undefined || epoch > latest)) latest = epoch
    }
  }
  return latest
}

// Whether a registry account is currently capped (its latest limit-reset epoch is in
// the future) and when it frees.
export const accountCap = (name: string, now = Date.now()): AccountCap => {
  const resetAt = latestResetEpoch(accountDir(name))
  if (resetAt === undefined) return { capped: false }
  return { capped: now / 1000 < resetAt, resetAt }
}

// Live usage from Anthropic's own OAuth usage endpoint (the same call Claude Code's
// `/usage` makes): the server-computed 5-hour and 7-day utilization percentages. We
// read the account's OAuth token live from its own `<accountDir>/.credentials.json`
// (Claude Code wrote it; we never persist it or the usage) and GET the endpoint.
// Degrades to null on any failure, missing token, non-subscription account (`{}`),
// expired token (401), or the ~1/min rate limit (429), so callers show "unknown".

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA = "oauth-2025-04-20"

export type UsageWindow = { pct: number; resetAt?: string }
export type LiveUsage = { fiveHour?: UsageWindow; sevenDay?: UsageWindow }

type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>

const defaultFetcher: Fetcher = async (url, init) => {
  const r = await fetch(url, init)
  return { status: r.status, json: () => r.json() }
}

// The OAuth access token for a registry account, read live from its own credentials
// file. Never cached. Returns null when absent (e.g. macOS Keychain-only, signed out).
const readToken = (name: string): string | null => {
  try {
    const cred = JSON.parse(
      fs.readFileSync(path.join(accountDir(name), ".credentials.json"), "utf8"),
    ) as { claudeAiOauth?: { accessToken?: unknown } }
    const t = cred?.claudeAiOauth?.accessToken
    return typeof t === "string" && t ? t : null
  } catch {
    return null
  }
}

// Parse the usage endpoint body. Prefers the top-level `five_hour`/`seven_day`
// { utilization, resets_at } objects, falling back to the newer `limits[]` array
// (kind "session" => 5h, "weekly_all" => 7d). Pure, so it is unit-testable.
export const parseUsage = (data: unknown): LiveUsage => {
  const d = (data ?? {}) as Record<string, unknown>
  const win = (o: unknown): UsageWindow | undefined => {
    const w = o as { utilization?: unknown; resets_at?: unknown }
    return w && typeof w.utilization === "number"
      ? { pct: w.utilization, resetAt: typeof w.resets_at === "string" ? w.resets_at : undefined }
      : undefined
  }
  let fiveHour = win(d.five_hour)
  let sevenDay = win(d.seven_day)
  if ((!fiveHour || !sevenDay) && Array.isArray(d.limits)) {
    for (const l of d.limits as { kind?: unknown; percent?: unknown; resets_at?: unknown }[]) {
      const w =
        typeof l?.percent === "number"
          ? { pct: l.percent, resetAt: typeof l.resets_at === "string" ? l.resets_at : undefined }
          : undefined
      if (l?.kind === "session" && !fiveHour) fiveHour = w
      if (l?.kind === "weekly_all" && !sevenDay) sevenDay = w
    }
  }
  return { fiveHour, sevenDay }
}

export const fetchLiveUsage = async (
  name: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<LiveUsage | null> => {
  const token = readToken(name)
  if (!token) return null
  try {
    const res = await fetcher(USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": "claude-code/2.1",
      },
    })
    if (res.status !== 200) return null
    return parseUsage(await res.json())
  } catch {
    return null
  }
}
