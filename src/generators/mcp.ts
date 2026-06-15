import fs from "node:fs"
import path from "node:path"

import {
  DEFAULT_SLACK_PACKAGE,
  type HttpServer,
  type SlackPackage,
  type SlackServer,
  type Workspace,
} from "@/config"
import { resolveAbsolute } from "@/env"
import { writeFileAtomic } from "@/io"

export const SLACK_MCP_VERSION = "1.3.0"

// The npx package spec for a workspace's chosen Slack server. The original is
// pinned to a known-good version; the @nrjdalal fork is kept on @latest by
// request (and doctor's unpinned check exempts it, see src/doctor.ts).
export const slackPackageSpec = (pkg: SlackPackage = DEFAULT_SLACK_PACKAGE): string =>
  pkg === "@nrjdalal/slack-mcp-server"
    ? "@nrjdalal/slack-mcp-server@latest"
    : `slack-mcp-server@${SLACK_MCP_VERSION}`

const GITHUB_URL = "https://api.githubcopilot.com/mcp/"

// Remote servers Claude Code authenticates via OAuth over streamable HTTP
// (just a URL each).
export const REMOTE: Record<string, string> = {
  atlassian: "https://mcp.atlassian.com/v1/mcp",
  canva: "https://mcp.canva.com/mcp",
  clickup: "https://mcp.clickup.com/mcp",
  hubspot: "https://mcp.hubspot.com",
  intercom: "https://mcp.intercom.com/mcp",
  linear: "https://mcp.linear.app/mcp",
  monday: "https://mcp.monday.com/mcp",
  notion: "https://mcp.notion.com/mcp",
  plane: "https://mcp.plane.so/http/mcp",
  sentry: "https://mcp.sentry.dev/mcp",
  stripe: "https://mcp.stripe.com",
  vercel: "https://mcp.vercel.com",
  webflow: "https://mcp.webflow.com/",
}

// github first (the primary identity), then the rest alphabetical
export const SERVER_TYPES = [
  "github",
  "atlassian",
  "canva",
  "clickup",
  "hubspot",
  "intercom",
  "linear",
  "monday",
  "notion",
  "plane",
  "sentry",
  "slack",
  "stripe",
  "vercel",
  "webflow",
] as const

export const managedKeys = (name: string) => SERVER_TYPES.map((t) => `${t}-${name}`)

export const mcpFilePath = (ws: Workspace) => path.join(resolveAbsolute(ws.path), ".mcp.json")

const httpUrl = (v: boolean | HttpServer | undefined, fallback: string) =>
  v && typeof v === "object" && v.url ? v.url : fallback

export const renderServers = (ws: Workspace): Record<string, unknown> => {
  const s = ws.servers as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of SERVER_TYPES) {
    const v = s[key]
    if (!v) continue
    const name = `${key}-${ws.name}`
    if (key === "github") {
      out[name] = {
        type: "http",
        url: GITHUB_URL,
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      }
    } else if (key === "slack") {
      const slack = v as SlackServer
      const env: Record<string, string> = {
        SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN}",
      }
      if (slack.addMessageTool) env.SLACK_MCP_ADD_MESSAGE_TOOL = "true"
      out[name] = {
        type: "stdio",
        command: "npx",
        args: ["-y", slackPackageSpec(slack.package), "--transport", "stdio"],
        env,
      }
    } else {
      out[name] = {
        type: "http",
        url: httpUrl(v as boolean | HttpServer, REMOTE[key]),
      }
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

// The one merge both `apply` (write) and `diff` (preview) use: preserve the
// user's non-managed keys, replace the keys inscope manages. Sharing it is what
// makes the diff provably the bytes apply will write. Returns a new doc so
// callers can serialize it without mutating their input.
export const mergeMcpDoc = (doc: Record<string, any>, ws: Workspace): Record<string, any> => {
  const servers: Record<string, unknown> =
    doc.mcpServers && typeof doc.mcpServers === "object" ? { ...doc.mcpServers } : {}
  for (const key of managedKeys(ws.name)) delete servers[key]
  Object.assign(servers, renderServers(ws))
  return { ...doc, mcpServers: servers }
}

export const serializeMcp = (doc: Record<string, any>): string =>
  JSON.stringify(doc, null, 2) + "\n"

// Pre-flight for `apply`: parse every workspace's .mcp.json before any write, so
// one unparseable file aborts the apply up front instead of after earlier files
// are already rewritten. readDocOrThrow only reads; it leaves files untouched.
export const preflightMcp = (workspaces: Workspace[]) => {
  for (const ws of workspaces) readDocOrThrow(mcpFilePath(ws))
}

export const applyMcp = (ws: Workspace) => {
  const file = mcpFilePath(ws)
  writeFileAtomic(file, serializeMcp(mergeMcpDoc(readDocOrThrow(file), ws)))
}

export const removeMcp = (ws: Workspace) => {
  const file = mcpFilePath(ws)
  if (!fs.existsSync(file)) return
  const doc = readDocOrThrow(file)
  if (doc.mcpServers && typeof doc.mcpServers === "object") {
    for (const key of managedKeys(ws.name)) delete doc.mcpServers[key]
  }
  writeFileAtomic(file, serializeMcp(doc))
}
