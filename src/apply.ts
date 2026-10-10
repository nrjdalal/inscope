import path from "node:path"

import type { Config } from "@/config"
import { gitconfigPath, home, hookPath, zshrcPath } from "@/env"
import { applyGitconfig, GITCONFIG_BLOCK_ID } from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { applyIsolation } from "@/generators/isolate"
import { applyMcp, mcpFilePath, preflightMcp } from "@/generators/mcp"
import { applyBypass, applyRouting, preflightRouting } from "@/generators/settings"
import { applySkills } from "@/generators/skills"
import { readFileOrEmpty, writeFileAtomic } from "@/io"
import { assertBlockWellFormed } from "@/managed-block"
import { proxyRoute } from "@/proxy"

const homeVar = (abs: string) => {
  const h = home()
  if (abs === h) return "$HOME"
  if (abs.startsWith(h + path.sep)) return `$HOME/${abs.slice(h.length + 1)}`
  return abs
}

const sourceLine = () => {
  const target = homeVar(hookPath())
  return `[ -r "${target}" ] && source "${target}"`
}

const ZSHRC_COMMENT =
  "# inscope: load each workspace's tokens (GitHub, Slack) from $PWD on every cd"

// A single, append-once source line with no managed-block markers: it never
// needs rewriting or removal, so matching on the line keeps re-runs idempotent.
export const renderZshrcSource = (current: string): string => {
  const line = sourceLine()
  if (current.includes(line)) return current
  const base = current.replace(/\n*$/, "")
  const block = `${ZSHRC_COMMENT}\n${line}`
  return base.length ? `${base}\n\n${block}\n` : `${block}\n`
}

export const ensureZshrcSource = () => {
  const file = zshrcPath()
  const current = readFileOrEmpty(file)
  const next = renderZshrcSource(current)
  if (next !== current) writeFileAtomic(file, next)
}

export const zshrcSourcesHook = (): boolean => readFileOrEmpty(zshrcPath()).includes(sourceLine())

export type ApplyResult = {
  hook: string
  gitconfig: boolean
  mcp: string[]
}

// Check every shared file apply edits in place before touching anything: one
// unparseable .mcp.json, a ~/.gitconfig whose inscope markers are malformed, or a
// login settings.json that cannot be routed through the proxy aborts here rather than
// after the hook and earlier files are already rewritten (a half-applied state).
// Commands that save the config first call this before saving.
export const preflightApply = (cfg: Config) => {
  preflightMcp(cfg.workspaces)
  assertBlockWellFormed(gitconfigPath(), GITCONFIG_BLOCK_ID)
  preflightRouting(cfg, proxyRoute(cfg))
}

export const applyAll = (cfg: Config): ApplyResult => {
  preflightApply(cfg)

  const hp = hookPath()
  writeFileAtomic(hp, renderHook(cfg))

  applyGitconfig(cfg)
  ensureZshrcSource()

  const mcp: string[] = []
  for (const ws of cfg.workspaces) {
    applyMcp(ws)
    applyIsolation(ws)
    // After applyIsolation has scaffolded the .inscope dir, write (or clear) the
    // bypass setting in that isolated login. A no-op for a non-isolated workspace.
    applyBypass(ws, cfg.bypass ?? false)
    mcp.push(mcpFilePath(ws))
  }
  // Every login (the shared base and each isolated one) sends its requests through the
  // proxy while one is configured; without one, inscope's routing keys are cleared.
  applyRouting(cfg, proxyRoute(cfg))

  // One pass over the whole config: the shared ~/.claude/skills is the union of every
  // non-isolated workspace, so skills cannot be materialized per-workspace. Clone-if
  // -missing only (no pull), so an apply is offline once a source is cached (a not-yet
  // -cached git skill still clones here on first apply). `inscope skill update` pulls.
  applySkills(cfg)

  return {
    hook: hp,
    gitconfig: cfg.workspaces.some((w) => w.git?.email || w.git?.name),
    mcp,
  }
}
