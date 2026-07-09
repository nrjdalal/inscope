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

// The non-isolated base login dir, matching the hook's `${__inscope_base_ccd:-$HOME/.claude}`
// and the counterpart to inscopeDirPath: a user's global CLAUDE_CONFIG_DIR when they set
// one, else ~/.claude. The current process's CLAUDE_CONFIG_DIR counts only when it is NOT
// one of inscope's own isolated dirs (the shell may sit in an isolated workspace, whose hook
// exported that dir), so a non-isolated workspace always lands on the base, never a sibling
// isolated login. Edge: a user with a *global* CLAUDE_CONFIG_DIR who runs from inside an
// isolated workspace falls back to ~/.claude here, since the isolation export overwrote the
// global in the env and the hook keeps the true base only in the non-exported
// `__inscope_base_ccd` shell var. Shared by generators/skills and status.
export const baseClaudeDir = (): string => {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  return env && path.basename(env) !== INSCOPE_DIR ? env : path.join(home(), ".claude")
}

export const gitignorePath = (ws: Workspace) => path.join(resolveAbsolute(ws.path), ".gitignore")

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

export const renderGitignore = (current: string, pooled = false): string => {
  if (isInscopeIgnored(current)) return current
  // A pooled workspace's `.inscope` is a SYMLINK; the dir-only pattern `.inscope/`
  // would not ignore it, so use the bare `.inscope`. isInscopeIgnored normalizes
  // both forms, so re-runs (and a switch between pooled/single) stay idempotent.
  const entry = pooled ? INSCOPE_DIR : GITIGNORE_ENTRY
  const base = current.replace(/\n*$/, "")
  const block = `${GITIGNORE_COMMENT}\n${entry}`
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
