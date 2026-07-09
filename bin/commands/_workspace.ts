import { applyAll } from "@/apply"
import {
  configExists,
  DEFAULT_SLACK_PACKAGE,
  defaultConfig,
  loadConfig,
  saveConfig,
  type Servers,
  type SlackPackage,
  type SlackServer,
  upsertWorkspace,
  type Workspace,
} from "@/config"
import { resolveAbsolute } from "@/env"
import { removeMcp, SERVER_TYPES } from "@/generators/mcp"
import { keychainHas, keychainSet, keychainSetCommand } from "@/secrets"
import { hyperlink, orange, promptHidden } from "~/bin/commands/_prompt"

export { slackKeychainFor } from "@/config"

export const SLACK_AUTH_DOCS =
  "https://github.com/korotovsky/slack-mcp-server/blob/HEAD/docs/01-authentication-setup.md#option-2-using-slack_mcp_xoxp_token-user-oauth"

export const SERVER_LABELS = SERVER_TYPES

export const enabledServers = (s: Servers): string[] =>
  SERVER_TYPES.filter((t) => Boolean((s as Record<string, unknown>)[t]))

export const buildServers = (
  list: string[],
  slack: { keychain: string; addMessageTool: boolean; package?: SlackPackage } | null,
): Servers => {
  const out: Record<string, unknown> = {}
  for (const t of SERVER_TYPES) {
    if (t === "slack") {
      if (!slack) {
        out[t] = false
        continue
      }
      const entry: SlackServer = { keychain: slack.keychain, addMessageTool: slack.addMessageTool }
      // Only persist a non-default package, so configs on the @nrjdalal default
      // stay free of a redundant `package` key; the pinned original persists as
      // package: "slack-mcp-server".
      if (slack.package && slack.package !== DEFAULT_SLACK_PACKAGE) entry.package = slack.package
      out[t] = entry
    } else {
      out[t] = list.includes(t)
    }
  }
  return out as Servers
}

// The Slack package picker, shared by `add` and `edit`. The default (@nrjdalal
// fork) is listed first so it is the default selection.
export const SLACK_PACKAGE_CHOICES: { label: string; value: SlackPackage }[] = [
  { label: "@nrjdalal/slack-mcp-server (default, latest)", value: "@nrjdalal/slack-mcp-server" },
  { label: "slack-mcp-server (korotovsky, pinned)", value: "slack-mcp-server" },
]

// Resolve a --slack-package flag value to a known package, accepting friendly
// aliases. Returns null for an unrecognized value so the caller can error out.
export const resolveSlackPackage = (input?: string): SlackPackage | null => {
  const v = (input ?? "").trim().toLowerCase()
  // empty or the literal "default" tracks DEFAULT_SLACK_PACKAGE (now the @nrjdalal fork)
  if (!v || v === "default") return DEFAULT_SLACK_PACKAGE
  if (["@nrjdalal/slack-mcp-server", "nrjdalal", "nrj"].includes(v))
    return "@nrjdalal/slack-mcp-server"
  if (["slack-mcp-server", "original", "korotovsky"].includes(v)) return "slack-mcp-server"
  return null
}

// The hint shown next to the interactive git email/name prompts. Pressing enter
// inherits the global (the workspace stores nothing and tracks global at commit
// time), so the hint just surfaces the global value; when none is set there is
// nothing to inherit, so blank means no git identity (a valid servers-only/
// gh-only setup).
export const gitGlobalHint = (global: string | null): string =>
  global ? `global: ${global}` : "no global set"

export const persist = (ws: Workspace) => {
  const cfg = configExists() ? loadConfig() : defaultConfig()
  const prior = cfg.workspaces.find((w) => w.name === ws.name)
  const next = upsertWorkspace(cfg, ws)
  saveConfig(next)
  applyAll(next)
  // Relocated to a new path: applyAll only writes paths still in the config, so
  // prune the now-orphaned managed block from the old path's .mcp.json.
  if (prior && resolveAbsolute(prior.path) !== resolveAbsolute(ws.path)) removeMcp(prior)
}

// After persisting: seed the Slack token now (hidden prompt), or print the
// one-time store command plus a link to the app-creation guide.
export const finalizeSlack = async (ws: Workspace, seed: boolean) => {
  if (!ws.servers.slack) return
  const svc = ws.servers.slack.keychain
  if (seed) {
    const token = await promptHidden(`Paste the Slack xoxp token for ${svc}: `)
    if (!token) {
      console.error("\nNo token entered; skipped keychain write.")
    } else {
      keychainSet(svc, token)
      console.log(`\n✓ stored ${svc} in the macOS keychain`)
    }
  } else if (!keychainHas(svc)) {
    console.log(
      `\nSlack token not in the keychain yet. Store it once with:\n${orange(keychainSetCommand(svc))}\n\nSetup guide: ${orange(hyperlink(SLACK_AUTH_DOCS))}`,
    )
  }
}
