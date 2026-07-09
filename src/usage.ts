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
