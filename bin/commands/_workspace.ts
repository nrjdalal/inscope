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
import { keychainHas, keychainSet, keychainSetCommand } from "@/secrets"
import { promptHidden } from "~/bin/commands/_prompt"

export const SLACK_AUTH_DOCS =
  "https://github.com/korotovsky/slack-mcp-server/blob/HEAD/docs/01-authentication-setup.md#option-2-using-slack_mcp_xoxp_token-user-oauth"

export const SERVER_LABELS = ["github", "linear", "notion", "slack"] as const

export const slackKeychainFor = (label: string) =>
  `SLACK_MCP_XOXP_TOKEN_${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`

export const enabledServers = (s: Servers): string[] =>
  [
    s.github && "github",
    s.linear && "linear",
    s.notion && "notion",
    s.slack && "slack",
  ].filter(Boolean) as string[]

export const buildServers = (
  list: string[],
  slack: { keychain: string; addMessageTool: boolean } | null,
): Servers => ({
  github: list.includes("github"),
  linear: list.includes("linear"),
  notion: list.includes("notion"),
  slack: slack
    ? { keychain: slack.keychain, addMessageTool: slack.addMessageTool }
    : false,
})

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
