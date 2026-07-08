import path from "node:path"

import type { Config } from "@/config"
import { home, hookPath, zshrcPath } from "@/env"
import { applyGitconfig } from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { applyIsolation } from "@/generators/isolate"
import { applyMcp, mcpFilePath, preflightMcp } from "@/generators/mcp"
import { readFileOrEmpty, writeFileAtomic } from "@/io"

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

export const applyAll = (cfg: Config): ApplyResult => {
  // Pre-flight every .mcp.json before touching anything: one unparseable file
  // aborts the whole apply here, rather than after the hook and earlier
  // .mcp.json files are already rewritten (a half-applied state).
  preflightMcp(cfg.workspaces)

  const hp = hookPath()
  writeFileAtomic(hp, renderHook(cfg))

  applyGitconfig(cfg)
  ensureZshrcSource()

  const mcp: string[] = []
  for (const ws of cfg.workspaces) {
    applyMcp(ws)
    applyIsolation(ws)
    mcp.push(mcpFilePath(ws))
  }

  return {
    hook: hp,
    gitconfig: cfg.workspaces.some((w) => w.git?.email || w.git?.name),
    mcp,
  }
}
