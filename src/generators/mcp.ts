import fs from "node:fs"
import path from "node:path"
import type { HttpServer, Workspace } from "@/config"
import { resolveAbsolute } from "@/env"

export const SLACK_MCP_VERSION = "1.3.0"

const GITHUB_URL = "https://api.githubcopilot.com/mcp/"
const LINEAR_URL = "https://mcp.linear.app/mcp"
const NOTION_URL = "https://mcp.notion.com/mcp"

export const SERVER_TYPES = ["github", "linear", "notion", "slack"] as const

export const managedKeys = (name: string) =>
  SERVER_TYPES.map((t) => `${t}-${name}`)

export const mcpFilePath = (ws: Workspace) =>
  path.join(resolveAbsolute(ws.path), ".mcp.json")

const httpUrl = (v: boolean | HttpServer | undefined, fallback: string) =>
  v && typeof v === "object" && v.url ? v.url : fallback

export const renderServers = (ws: Workspace): Record<string, unknown> => {
  const s = ws.servers
  const out: Record<string, unknown> = {}
  if (s.github) {
    out[`github-${ws.name}`] = {
      type: "http",
      url: GITHUB_URL,
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    }
  }
  if (s.linear) {
    out[`linear-${ws.name}`] = {
      type: "http",
      url: httpUrl(s.linear, LINEAR_URL),
    }
  }
  if (s.notion) {
    out[`notion-${ws.name}`] = {
      type: "http",
      url: httpUrl(s.notion, NOTION_URL),
    }
  }
  if (s.slack) {
    const env: Record<string, string> = {
      SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN}",
    }
    if (s.slack.addMessageTool) env.SLACK_MCP_ADD_MESSAGE_TOOL = "true"
    out[`slack-${ws.name}`] = {
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        `slack-mcp-server@${SLACK_MCP_VERSION}`,
        "--transport",
        "stdio",
      ],
      env,
    }
  }
  return out
}

export const renderMcp = (ws: Workspace) => ({ mcpServers: renderServers(ws) })

const readDoc = (file: string): Record<string, any> => {
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

// Strict read for the write paths: never silently discard an existing file we
// cannot parse. Throwing leaves the user's .mcp.json untouched.
const readDocOrThrow = (file: string): Record<string, any> => {
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    throw new Error(
      `${file} is not valid JSON; fix or remove it, then re-run inscope (left it untouched)`,
    )
  }
}

export const readMcp = (ws: Workspace): Record<string, any> | null => {
  const file = mcpFilePath(ws)
  return fs.existsSync(file) ? readDoc(file) : null
}

export const applyMcp = (ws: Workspace) => {
  const file = mcpFilePath(ws)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const doc = readDocOrThrow(file)
  const servers: Record<string, unknown> =
    doc.mcpServers && typeof doc.mcpServers === "object"
      ? { ...doc.mcpServers }
      : {}
  for (const key of managedKeys(ws.name)) delete servers[key]
  Object.assign(servers, renderServers(ws))
  doc.mcpServers = servers
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
}

export const removeMcp = (ws: Workspace) => {
  const file = mcpFilePath(ws)
  if (!fs.existsSync(file)) return
  const doc = readDocOrThrow(file)
  if (doc.mcpServers && typeof doc.mcpServers === "object") {
    for (const key of managedKeys(ws.name)) delete doc.mcpServers[key]
  }
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
}
