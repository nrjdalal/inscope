import fs from "node:fs"
import path from "node:path"

import type { Config, Workspace } from "@/config"
import { contractTilde, gitconfigPath, gitIncludeDir } from "@/env"
import { writeFileAtomic } from "@/io"
import { removeBlock, upsertBlock } from "@/managed-block"

export const GITCONFIG_BLOCK_ID = "gitconfig"

export const hasGitIdentity = (ws: Workspace) => !!(ws.git && (ws.git.email || ws.git.name))

export const perWorkspaceGitconfigPath = (name: string) =>
  path.join(gitIncludeDir(), `${name}.gitconfig`)

const gitdirPattern = (p: string) => contractTilde(p).replace(/\/+$/, "") + "/"

export const renderGitInclude = (cfg: Config): string =>
  cfg.workspaces
    .filter(hasGitIdentity)
    .map(
      (w) =>
        `[includeIf "gitdir:${gitdirPattern(w.path)}"]\n\tpath = ${contractTilde(
          perWorkspaceGitconfigPath(w.name),
        )}`,
    )
    .join("\n")

export const renderPerWorkspaceGitconfig = (ws: Workspace): string => {
  const lines = ["# Managed by inscope. Do not edit by hand.", "[user]"]
  if (ws.git?.email) lines.push(`\temail = ${ws.git.email}`)
  if (ws.git?.name) lines.push(`\tname = ${ws.git.name}`)
  return lines.join("\n") + "\n"
}

export const applyGitconfig = (cfg: Config) => {
  fs.mkdirSync(gitIncludeDir(), { recursive: true })
  for (const ws of cfg.workspaces) {
    if (hasGitIdentity(ws)) {
      writeFileAtomic(perWorkspaceGitconfigPath(ws.name), renderPerWorkspaceGitconfig(ws))
    } else {
      // Identity dropped (e.g. via `edit`): prune any per-workspace file left
      // from before. The includeIf no longer references it, so it is inert, but
      // it would otherwise linger on disk as stale, confusing state.
      removePerWorkspaceGitconfig(ws.name)
    }
  }
  const block = renderGitInclude(cfg)
  if (block) {
    upsertBlock(gitconfigPath(), GITCONFIG_BLOCK_ID, block)
  } else {
    removeBlock(gitconfigPath(), GITCONFIG_BLOCK_ID)
  }
}

export const removePerWorkspaceGitconfig = (name: string) => {
  const file = perWorkspaceGitconfigPath(name)
  if (fs.existsSync(file)) fs.rmSync(file)
}
