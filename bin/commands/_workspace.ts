import { applyAll } from "@/apply"
import {
  configExists,
  DATADOG_SITES,
  type DatadogSite,
  DEFAULT_DATADOG_SITE,
  DEFAULT_SLACK_PACKAGE,
  defaultConfig,
  loadConfig,
  NYLAS_REGIONS,
  type NylasRegion,
  type NylasServer,
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

export { nylasKeychainFor, slackKeychainFor } from "@/config"

export const NYLAS_AUTH_DOCS = "https://developer.nylas.com/docs/dev-guide/mcp/"

export const SLACK_AUTH_DOCS =
  "https://github.com/korotovsky/slack-mcp-server/blob/HEAD/docs/01-authentication-setup.md#option-2-using-slack_mcp_xoxp_token-user-oauth"

export const SERVER_LABELS = SERVER_TYPES

export const enabledServers = (s: Servers): string[] =>
  SERVER_TYPES.filter((t) => Boolean((s as Record<string, unknown>)[t]))

// Per-server details beyond on/off that buildServers persists.
export type ServerOptions = {
  datadogSite?: DatadogSite
  nylas?: NylasServer | null
}

export const buildServers = (
  list: string[],
  slack: { keychain: string; addMessageTool: boolean; package?: SlackPackage } | null,
  { datadogSite = DEFAULT_DATADOG_SITE, nylas = null }: ServerOptions = {},
): Servers => {
  const out: Record<string, unknown> = {}
  for (const t of SERVER_TYPES) {
    if (t === "datadog") {
      // Only persist a non-default site, so a US1 workspace stays `datadog: true`.
      out[t] = list.includes(t) && (datadogSite === DEFAULT_DATADOG_SITE || { site: datadogSite })
    } else if (t === "nylas") {
      // Only persist a non-default region, so a US workspace carries just its key.
      out[t] = nylas
        ? { keychain: nylas.keychain, ...(nylas.region === "eu" ? { region: "eu" } : {}) }
        : false
    } else if (t === "slack") {
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

// Datadog's regional sites, shared by `add` and `edit`, labeled with the region
// code Datadog shows in its site selector. US1 (the default) is listed first.
const DATADOG_REGIONS: Record<DatadogSite, string> = {
  "datadoghq.com": "US1",
  "us3.datadoghq.com": "US3",
  "us5.datadoghq.com": "US5",
  "datadoghq.eu": "EU1",
  "ap1.datadoghq.com": "AP1",
  "ap2.datadoghq.com": "AP2",
  "uk1.datadoghq.com": "UK1",
}

export const DATADOG_SITE_CHOICES: { label: string; value: DatadogSite }[] = DATADOG_SITES.map(
  (site) => ({ label: `${DATADOG_REGIONS[site]} (${site})`, value: site }),
)

// Resolve a --datadog-site flag value to a known site, accepting the site itself
// or its region code (us1, eu, eu1, ap1, ...). Returns null for an unrecognized
// value so the caller can error out.
export const resolveDatadogSite = (input?: string): DatadogSite | null => {
  const v = (input ?? "").trim().toLowerCase()
  if (!v || v === "default") return DEFAULT_DATADOG_SITE
  if (v === "eu") return "datadoghq.eu"
  const byRegion = DATADOG_SITES.find((s) => DATADOG_REGIONS[s].toLowerCase() === v)
  if (byRegion) return byRegion
  return DATADOG_SITES.find((s) => s === v) ?? null
}

// Resolve a --nylas-region flag value. Returns null for an unrecognized value.
export const resolveNylasRegion = (input?: string): NylasRegion | null => {
  const v = (input ?? "").trim().toLowerCase()
  if (!v || v === "default") return "us"
  return NYLAS_REGIONS.find((r) => r === v) ?? null
}

export const NYLAS_REGION_CHOICES: { label: string; value: NylasRegion }[] = [
  { label: "US (mcp.us.nylas.com)", value: "us" },
  { label: "EU (mcp.eu.nylas.com)", value: "eu" },
]

// Store (or point at how to store) the workspace's Nylas API key, like finalizeSlack.
export const finalizeNylas = async (ws: Workspace, seed: boolean) => {
  if (!ws.servers.nylas) return
  const svc = ws.servers.nylas.keychain
  if (seed) {
    const key = await promptHidden(`Paste the Nylas API key for ${svc}: `)
    if (!key) {
      console.error("\nNo key entered; skipped keychain write.")
    } else {
      keychainSet(svc, key)
      console.log(`\n✓ stored ${svc} in the macOS keychain`)
    }
  } else if (!keychainHas(svc)) {
    console.log(
      `\nNylas API key not in the keychain yet. Store it once with:\n${orange(keychainSetCommand(svc, "nyk_..."))}\n\nSetup guide: ${orange(hyperlink(NYLAS_AUTH_DOCS))}`,
    )
  }
}

// The site a workspace's datadog server is on (US1 unless it names one).
export const datadogSiteOf = (s: Servers): DatadogSite =>
  (typeof s.datadog === "object" && s.datadog.site) || DEFAULT_DATADOG_SITE

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
