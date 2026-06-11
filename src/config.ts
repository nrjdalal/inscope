import fs from "node:fs"
import path from "node:path"
import { configPath, contractTilde, resolveAbsolute } from "@/env"

export type SlackServer = { keychain: string; addMessageTool?: boolean }

export type HttpServer = { url?: string }

export type Servers = {
  github?: boolean
  atlassian?: boolean | HttpServer
  canva?: boolean | HttpServer
  clickup?: boolean | HttpServer
  hubspot?: boolean | HttpServer
  intercom?: boolean | HttpServer
  linear?: boolean | HttpServer
  monday?: boolean | HttpServer
  notion?: boolean | HttpServer
  plane?: boolean | HttpServer
  sentry?: boolean | HttpServer
  slack?: SlackServer | false
  stripe?: boolean | HttpServer
  vercel?: boolean | HttpServer
  webflow?: boolean | HttpServer
}

export type Workspace = {
  name: string
  path: string
  gh?: string
  git?: { email?: string; name?: string }
  servers: Servers
}

export type Config = {
  version: number
  workspaces: Workspace[]
}

export const CONFIG_VERSION = 1

export const defaultConfig = (): Config => ({
  version: CONFIG_VERSION,
  workspaces: [],
})

export const configExists = () => fs.existsSync(configPath())

export const loadConfig = (): Config => {
  const file = configPath()
  const raw = fs.readFileSync(file, "utf8")
  const parsed = JSON.parse(raw) as Config
  validateConfig(parsed)
  return parsed
}

export const saveConfig = (cfg: Config) => {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n")
}

export const validateConfig = (cfg: Config) => {
  if (!cfg || typeof cfg !== "object")
    throw new Error("config is not an object")
  if (!Array.isArray(cfg.workspaces))
    throw new Error("config.workspaces must be an array")
  const seen = new Set<string>()
  for (const ws of cfg.workspaces) {
    if (!ws.name) throw new Error("a workspace is missing a name")
    if (!ws.path) throw new Error(`workspace "${ws.name}" is missing a path`)
    if (seen.has(ws.name))
      throw new Error(`duplicate workspace name "${ws.name}"`)
    seen.add(ws.name)
  }
}

export const labelFromPath = (p: string) => path.basename(resolveAbsolute(p))

export const findWorkspace = (
  cfg: Config,
  key: string,
): Workspace | undefined => {
  const byName = cfg.workspaces.find((w) => w.name === key)
  if (byName) return byName
  const target = resolveAbsolute(key)
  return cfg.workspaces.find((w) => resolveAbsolute(w.path) === target)
}

export const upsertWorkspace = (cfg: Config, ws: Workspace): Config => {
  const next = cfg.workspaces.filter((w) => w.name !== ws.name)
  next.push({ ...ws, path: contractTilde(ws.path) })
  next.sort((a, b) => a.name.localeCompare(b.name))
  return { ...cfg, workspaces: next }
}

export const removeWorkspace = (
  cfg: Config,
  key: string,
): { cfg: Config; removed?: Workspace } => {
  const removed = findWorkspace(cfg, key)
  if (!removed) return { cfg }
  return {
    cfg: {
      ...cfg,
      workspaces: cfg.workspaces.filter((w) => w.name !== removed.name),
    },
    removed,
  }
}
