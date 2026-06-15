import fs from "node:fs"

import {
  type Config,
  DEFAULT_SLACK_PACKAGE,
  type HttpServer,
  type Servers,
  type SlackServer,
  type Workspace,
} from "@/config"
import { gitconfigPath, hookPath } from "@/env"
import {
  GITCONFIG_BLOCK_ID,
  hasGitIdentity,
  perWorkspaceGitconfigPath,
  renderGitInclude,
  renderPerWorkspaceGitconfig,
} from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import {
  mcpFilePath,
  mergeMcpDoc,
  REMOTE,
  SERVER_TYPES,
  serializeMcp,
  slackPackageFromArgs,
} from "@/generators/mcp"
import { readFileOrEmpty } from "@/io"
import { readBlock } from "@/managed-block"

const parseDoc = (file: string): Record<string, any> | null => {
  const raw = readFileOrEmpty(file)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// What `inscope apply` would write to a workspace's .mcp.json, via the same
// merge apply uses — so this preview cannot diverge from what apply writes.
export const mcpTarget = (ws: Workspace): string =>
  serializeMcp(mergeMcpDoc(parseDoc(mcpFilePath(ws)) ?? {}, ws))

// A `.mcp.json` that exists but won't parse: `apply` (via readDocOrThrow) refuses
// to rewrite it, so surface that instead of a misleading clean-rewrite diff.
export const mcpError = (ws: Workspace): string | null => {
  const file = mcpFilePath(ws)
  if (!fs.existsSync(file)) return null
  try {
    JSON.parse(fs.readFileSync(file, "utf8"))
    return null
  } catch {
    return "invalid JSON; `apply` will not touch it until you fix it"
  }
}

export type Drift = { label: string; path: string; current: string; next: string; error?: string }

// Every managed artifact `apply` would change, with its on-disk and rendered
// content. Only entries that actually differ are returned.
export const computeDrift = (cfg: Config): Drift[] => {
  const drifts: Drift[] = []

  const hp = hookPath()
  drifts.push({ label: "hook", path: hp, current: readFileOrEmpty(hp), next: renderHook(cfg) })

  drifts.push({
    label: "gitconfig",
    path: gitconfigPath(),
    current: readBlock(gitconfigPath(), GITCONFIG_BLOCK_ID) ?? "",
    next: renderGitInclude(cfg),
  })

  for (const ws of cfg.workspaces) {
    if (!hasGitIdentity(ws)) continue
    const f = perWorkspaceGitconfigPath(ws.name)
    drifts.push({
      label: `gitconfig:${ws.name}`,
      path: f,
      current: readFileOrEmpty(f),
      next: renderPerWorkspaceGitconfig(ws),
    })
  }

  for (const ws of cfg.workspaces) {
    const f = mcpFilePath(ws)
    const err = mcpError(ws)
    if (err) {
      drifts.push({ label: `mcp:${ws.name}`, path: f, current: "", next: "", error: err })
      continue
    }
    drifts.push({
      label: `mcp:${ws.name}`,
      path: f,
      current: readFileOrEmpty(f),
      next: mcpTarget(ws),
    })
  }

  return drifts.filter((d) => d.error != null || d.current !== d.next)
}

// Minimal LCS line diff: "  " unchanged, "- " removed, "+ " added.
export const diffLines = (a: string, b: string): string => {
  const A = a.length ? a.split("\n") : []
  const B = b.length ? b.split("\n") : []
  const m = A.length
  const n = B.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  )
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push(`  ${A[i]}`)
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${A[i]}`)
      i++
    } else {
      out.push(`+ ${B[j]}`)
      j++
    }
  }
  while (i < m) out.push(`- ${A[i++]}`)
  while (j < n) out.push(`+ ${B[j++]}`)
  return out.join("\n")
}

// Back-sync: settings present in a workspace's on-disk .mcp.json that the config
// can express but does not yet, so `apply` would otherwise drop them. Returns a
// patched config and a human-readable list of what would be adopted.
export const adoptable = (cfg: Config): { cfg: Config; changes: string[] } => {
  const changes: string[] = []
  const workspaces = cfg.workspaces.map((ws) => {
    const onDisk = parseDoc(mcpFilePath(ws))?.mcpServers
    if (!onDisk || typeof onDisk !== "object") return ws

    let servers: Servers = ws.servers

    const slack = ws.servers.slack
    if (
      slack &&
      !slack.addMessageTool &&
      onDisk[`slack-${ws.name}`]?.env?.SLACK_MCP_ADD_MESSAGE_TOOL === "true"
    ) {
      servers = { ...servers, slack: { ...slack, addMessageTool: true } }
      changes.push(`${ws.name}: slack.addMessageTool = true`)
    }

    // adopt the slack package the on-disk .mcp.json runs when it differs from the
    // config, so a hand-edited .mcp.json (e.g. switched to the @nrjdalal fork) can
    // be pulled back into the config instead of being reverted by the next apply.
    // Reads servers.slack (not ws.servers.slack) to layer on the addMessageTool
    // adopt above. A diskPkg matching the default drops the redundant key.
    const curSlack = servers.slack
    if (curSlack) {
      const diskPkg = slackPackageFromArgs(onDisk[`slack-${ws.name}`]?.args)
      const curPkg = curSlack.package ?? DEFAULT_SLACK_PACKAGE
      if (diskPkg && diskPkg !== curPkg) {
        const nextSlack: SlackServer = { ...curSlack }
        if (diskPkg === DEFAULT_SLACK_PACKAGE) delete nextSlack.package
        else nextSlack.package = diskPkg
        servers = { ...servers, slack: nextSlack }
        changes.push(`${ws.name}: slack.package = ${diskPkg}`)
      }
    }

    // remote (URL-only) servers: adopt a custom URL on a configured server, or a
    // whole server present only on disk. github/slack are special shapes (fixed
    // headers / a keychain name the .mcp.json doesn't carry), so a wholly on-disk
    // one of those isn't reconstructable here; add it via `inscope edit`.
    for (const key of SERVER_TYPES) {
      if (key === "github" || key === "slack") continue
      const diskUrl = onDisk[`${key}-${ws.name}`]?.url
      if (typeof diskUrl !== "string") continue
      const cur = (ws.servers as Record<string, unknown>)[key]
      if (!cur) {
        servers = { ...servers, [key]: diskUrl === REMOTE[key] ? true : { url: diskUrl } }
        changes.push(`${ws.name}: ${key} = ${diskUrl === REMOTE[key] ? "enabled" : diskUrl}`)
        continue
      }
      const curUrl = typeof cur === "object" ? (cur as HttpServer).url : undefined
      if (diskUrl !== (curUrl ?? REMOTE[key])) {
        servers = { ...servers, [key]: { url: diskUrl } }
        changes.push(`${ws.name}: ${key}.url = ${diskUrl}`)
      }
    }

    return servers === ws.servers ? ws : { ...ws, servers }
  })
  return { cfg: { ...cfg, workspaces }, changes }
}
