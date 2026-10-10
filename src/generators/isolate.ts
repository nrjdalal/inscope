import fs from "node:fs"
import path from "node:path"

import type { Workspace } from "@/config"
import { home, resolveAbsolute } from "@/env"
import { readFileOrEmpty, writeFileAtomic } from "@/io"

// The workspace-local Claude config dir an isolated workspace runs from. Named
// `.inscope` (not `.claude`) so it never collides with Claude Code's own
// project-scoped `.claude/` for settings/commands. The chpwd hook exports
// CLAUDE_CONFIG_DIR pointing here whenever $PWD is under the workspace (see
// generators/hook.ts).
export const INSCOPE_DIR = ".inscope"

export const inscopeDirPath = (ws: Workspace) => path.join(resolveAbsolute(ws.path), INSCOPE_DIR)

// The non-isolated base login dir, matching the hook's `${INSCOPE_BASE_CCD:-$HOME/.claude}`
// and the counterpart to inscopeDirPath: a user's global CLAUDE_CONFIG_DIR when they set
// one, else ~/.claude. The hook exports the true base as INSCOPE_BASE_CCD, so it is read
// first (empty means ~/.claude); without it, the current process's CLAUDE_CONFIG_DIR
// counts only when it is NOT one of inscope's own isolated dirs (the shell may sit in an
// isolated workspace, whose hook exported that dir), so a non-isolated workspace always
// lands on the base, never a sibling isolated login. Shared by generators/skills and status.
export const baseClaudeDir = (): string => {
  const fallback = path.join(home(), ".claude")
  // Trusted only while an isolated hook is live (it exports INSCOPE_CCD alongside); a
  // leftover from a shell that once had isolation must not outrank the live value.
  const base = process.env.INSCOPE_BASE_CCD
  if (base !== undefined && process.env.INSCOPE_CCD !== undefined) return base.trim() || fallback
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  return env && path.basename(env) !== INSCOPE_DIR ? env : fallback
}

// The Claude config dir a workspace runs on: its own `.inscope` when isolated, else the
// shared base. The one place that decides it, so the hook, status, doctor, skills, and
// settings all agree.
export const loginDir = (ws: Workspace): string =>
  ws.isolate ? inscopeDirPath(ws) : baseClaudeDir()

const gitignorePath = (ws: Workspace) => path.join(resolveAbsolute(ws.path), ".gitignore")

// `.inscope/` holds a Claude login, so it must never be committed. The entry is
// appended once with no managed-block markers (like the ~/.zshrc source line): it
// never needs rewriting, so matching on the line keeps re-runs idempotent, and a
// user who already ignores it (as `.inscope`, `.inscope/`, or the anchored
// `/.inscope[/]`) is left alone.
export const GITIGNORE_ENTRY = `${INSCOPE_DIR}/`

export const isInscopeIgnored = (current: string): boolean =>
  current.split("\n").some((l) => {
    // normalize a rule to compare against `.inscope`: drop a leading anchor slash
    // and a trailing dir slash, so `/.inscope/`, `.inscope/`, and `.inscope` all
    // count as already-ignored (a glob like `.inscope*` still won't, by design).
    const t = l.trim().replace(/^\//, "").replace(/\/$/, "")
    return t === INSCOPE_DIR
  })

// OS/tooling droppings that do not indicate a Claude login. macOS Finder/Spotlight
// leave `.DS_Store` in browsed folders, which would otherwise read as "signed in".
const NON_LOGIN_ENTRIES = new Set([".DS_Store", ".localized"])

// Whether an isolated `.inscope` looks signed in: it exists as a readable dir with
// real content (Claude fills it on first login). An empty/absent dir, a path that
// is a file, or an unreadable one all count as not-signed-in rather than throwing,
// so doctor degrades to its "sign in once" warning instead of crashing.
export const inscopeSignedIn = (dir: string): boolean => {
  try {
    return fs.readdirSync(dir).some((e) => !NON_LOGIN_ENTRIES.has(e))
  } catch {
    return false
  }
}

const GITIGNORE_COMMENT = "# inscope: workspace-local Claude config dir (holds a login)"

export const renderGitignore = (current: string): string => {
  if (isInscopeIgnored(current)) return current
  const base = current.replace(/\n*$/, "")
  const block = `${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}`
  return base.length ? `${base}\n\n${block}\n` : `${block}\n`
}

// Scaffold an isolated workspace: create the empty `.inscope` config dir (Claude
// populates it and prompts for login on first launch there) and make sure the
// workspace's .gitignore excludes it. A no-op for a non-isolated workspace.
//
// Un-isolating does not delete `.inscope` (it holds a live login; that is the
// user's to remove) nor prune the .gitignore line (harmless if the dir is gone).
export const applyIsolation = (ws: Workspace) => {
  if (!ws.isolate) return
  fs.mkdirSync(inscopeDirPath(ws), { recursive: true })
  const gi = gitignorePath(ws)
  const current = readFileOrEmpty(gi)
  const next = renderGitignore(current)
  if (next !== current) writeFileAtomic(gi, next)
}
