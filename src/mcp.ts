import { activeAccount, isSignedIn, nextUsable, performSwitch, poolFor } from "@/accounts"
import { type Config, configExists, currentWorkspace, loadConfig } from "@/config"
import { runDoctor } from "@/doctor"
import { resolveAbsolute } from "@/env"
import { resolveStatus } from "@/status"
import { accountCap } from "@/usage"
import { name, version } from "~/package.json"

// A minimal Model Context Protocol server, hand-rolled over JSON-RPC 2.0 so
// inscope stays zero-dependency (the SDK is a convenience wrapper, not a
// requirement: the client speaks the wire protocol, not the SDK). The transport
// (newline-delimited JSON on stdio) lives in bin/commands/mcp.ts; this module is
// the pure dispatcher, a request object in and a response object (or null for a
// notification) out, so it is unit-testable without wiring up stdin/stdout.

export type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

// The tools inscope exposes: three read-only introspection tools (identity for a
// directory, the workspaces, the health checks) plus inscope_switch_account, the one
// mutating tool, which re-points a pooled workspace to another Claude account.
export const MCP_TOOLS = [
  {
    name: "inscope_status",
    description:
      "Resolve the inscope identity for a directory: the Claude login (shared or isolated), GitHub account, git commit email, MCP servers, and skills.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to resolve (absolute or ~). Defaults to the current directory.",
        },
      },
    },
  },
  {
    name: "inscope_list",
    description: "List every configured inscope workspace and its identity.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inscope_doctor",
    description:
      "Verify the inscope setup: gh tokens, keychain entries, git emails, the hook, and skill links. Returns each check's status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inscope_switch_account",
    description:
      "Switch a workspace's active Claude account by re-pointing its .inscope symlink, e.g. when the current account hit its usage limit. Omit `account` to auto-pick the next signed-in, uncapped account in the pool. Effective on the next `claude` launch.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "A directory in the target workspace. Defaults to the current directory.",
        },
        account: {
          type: "string",
          description: "The account to switch to. Omit to auto-pick the next uncapped one.",
        },
      },
    },
  },
] as const

const asText = (data: unknown): ToolResult => ({
  content: [
    { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
  ],
})
const asError = (msg: string): ToolResult => ({
  content: [{ type: "text", text: msg }],
  isError: true,
})

const callTool = (toolName: string, args: Record<string, unknown> | undefined): ToolResult => {
  if (!configExists()) return asError("No inscope config found. Run `inscope add <path>` first.")
  try {
    const cfg: Config = loadConfig()
    switch (toolName) {
      case "inscope_status": {
        const p =
          typeof args?.path === "string" && args.path ? resolveAbsolute(args.path) : process.cwd()
        return asText(resolveStatus(cfg, { cwd: p }))
      }
      case "inscope_list":
        return asText(cfg.workspaces)
      case "inscope_doctor":
        return asText(runDoctor(cfg))
      case "inscope_switch_account": {
        const p =
          typeof args?.path === "string" && args.path ? resolveAbsolute(args.path) : process.cwd()
        const ws = currentWorkspace(cfg, p)
        if (!ws) return asError(`No inscope workspace resolves for ${p}.`)
        const pool = poolFor(ws)
        if (!pool.length) return asError(`Workspace "${ws.name}" has no account pool.`)
        let target = typeof args?.account === "string" && args.account ? args.account : undefined
        if (target && !pool.includes(target))
          return asError(`"${target}" is not in ${ws.name}'s pool (${pool.join(", ")}).`)
        if (!target) {
          const next = nextUsable(
            ws,
            activeAccount(ws),
            (n) => isSignedIn(n) && !accountCap(n).capped,
          )
          if (!next)
            return asError(`No signed-in, uncapped account available in ${ws.name}'s pool.`)
          target = next
        }
        if (!isSignedIn(target)) return asError(`Account "${target}" is not signed in.`)
        const { previous, active } = performSwitch(cfg, ws, target)
        return asText({ workspace: ws.name, previous, active })
      }
      default:
        return asError(`Unknown tool: ${toolName}`)
    }
  } catch (err) {
    return asError(`inscope error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Advertised when the client omits a version; when it sends one we echo it back so
// we agree on whatever protocol revision it speaks.
const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

export const handleMcpRequest = (req: JsonRpcRequest): JsonRpcResponse | null => {
  // A JSON-RPC notification (no id, e.g. notifications/initialized) gets no reply.
  if (req.id === undefined) return null
  const id = req.id
  const { method, params } = req
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result })
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  })

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name, version },
      })
    case "tools/list":
      return reply({ tools: MCP_TOOLS })
    case "tools/call": {
      const toolName = typeof params?.name === "string" ? params.name : ""
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>
      return reply(callTool(toolName, toolArgs))
    }
    case "ping":
      return reply({})
    default:
      return fail(-32601, `Method not found: ${method}`)
  }
}
