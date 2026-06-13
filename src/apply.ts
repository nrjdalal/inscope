import fs from "node:fs"
import path from "node:path"

import type { Config } from "@/config"
import { home, hookPath, zshrcPath } from "@/env"
import { applyGitconfig } from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { applyMcp, mcpFilePath } from "@/generators/mcp"

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
  let current = ""
  try {
    current = fs.readFileSync(file, "utf8")
  } catch {}
  const next = renderZshrcSource(current)
  if (next !== current) fs.writeFileSync(file, next)
}

export const zshrcSourcesHook = (): boolean => {
  try {
    return fs.readFileSync(zshrcPath(), "utf8").includes(sourceLine())
  } catch {
    return false
  }
}

export type ApplyResult = {
  hook: string
  gitconfig: boolean
  mcp: string[]
}

export const applyAll = (cfg: Config): ApplyResult => {
  const hp = hookPath()
  fs.mkdirSync(path.dirname(hp), { recursive: true })
  fs.writeFileSync(hp, renderHook(cfg))

  applyGitconfig(cfg)
  ensureZshrcSource()

  const mcp: string[] = []
  for (const ws of cfg.workspaces) {
    applyMcp(ws)
    mcp.push(mcpFilePath(ws))
  }

  return {
    hook: hp,
    gitconfig: cfg.workspaces.some((w) => w.git?.email || w.git?.name),
    mcp,
  }
}
