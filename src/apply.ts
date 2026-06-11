import fs from "node:fs"
import path from "node:path"
import type { Config } from "@/config"
import { home, hookPath, zshrcPath } from "@/env"
import { applyGitconfig } from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { applyMcp, mcpFilePath } from "@/generators/mcp"
import { upsertBlock } from "@/managed-block"

export const ZSHRC_BLOCK_ID = "zshrc"

const homeVar = (abs: string) => {
  const h = home()
  if (abs === h) return "$HOME"
  if (abs.startsWith(h + path.sep)) return `$HOME/${abs.slice(h.length + 1)}`
  return abs
}

export const ensureZshrcSource = () => {
  const target = homeVar(hookPath())
  const content =
    `# Loads each workspace's tokens (GitHub, Slack) from $PWD on every cd.\n` +
    `[ -r "${target}" ] && source "${target}"`
  upsertBlock(zshrcPath(), ZSHRC_BLOCK_ID, content)
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
