import { applyAll } from "@/apply"
import {
  configExists,
  defaultConfig,
  loadConfig,
  saveConfig,
  upsertWorkspace,
  type Servers,
  type Workspace,
} from "@/config"
import { SERVER_TYPES } from "@/generators/mcp"
import { keychainHas, keychainSet, keychainSetCommand } from "@/secrets"
import { promptHidden } from "~/bin/commands/_prompt"

export const SLACK_AUTH_DOCS =
  "https://github.com/korotovsky/slack-mcp-server/blob/HEAD/docs/01-authentication-setup.md#option-2-using-slack_mcp_xoxp_token-user-oauth"

export const SERVER_LABELS = SERVER_TYPES

export const slackKeychainFor = (label: string) =>
  `SLACK_MCP_XOXP_TOKEN_${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`

export const enabledServers = (s: Servers): string[] =>
  SERVER_TYPES.filter((t) => Boolean((s as Record<string, unknown>)[t]))

export const buildServers = (
  list: string[],
  slack: { keychain: string; addMessageTool: boolean } | null,
): Servers => {
  const out: Record<string, unknown> = {}
  for (const t of SERVER_TYPES) {
    out[t] =
      t === "slack"
        ? slack
          ? { keychain: slack.keychain, addMessageTool: slack.addMessageTool }
          : false
        : list.includes(t)
  }
  return out as Servers
}

export const persist = (ws: Workspace) => {
  const cfg = configExists() ? loadConfig() : defaultConfig()
  const next = upsertWorkspace(cfg, ws)
  saveConfig(next)
  applyAll(next)
}

// After persisting: seed the Slack token now (hidden prompt), or print the
// one-time store command plus a link to the app-creation guide.
export const finalizeSlack = async (ws: Workspace, seed: boolean) => {
  if (!ws.servers.slack) return
  const svc = ws.servers.slack.keychain
  if (seed) {
    const token = await promptHidden(`Paste the Slack xoxp token for ${svc}: `)
    if (!token) {
      console.error("No token entered; skipped keychain write.")
    } else {
      keychainSet(svc, token)
      console.log(`✓ stored ${svc} in the macOS keychain`)
    }
  } else if (!keychainHas(svc)) {
    console.log(
      `\nSlack token not in the keychain yet. Create a Slack app (xoxp user OAuth):\n  ${SLACK_AUTH_DOCS}\nthen store the token once with:\n  ${keychainSetCommand(svc)}`,
    )
  }
}
