import { applyAll, preflightApply } from "@/apply"
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
import { removeMcp, sameMcpFile, SERVER_TYPES } from "@/generators/mcp"
import { sharedNameClashes } from "@/generators/skills"
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

// `prev` is the workspace's stored servers when updating one: a server that stays
// enabled keeps its stored per-server details (a custom `url` adopted from the
// .mcp.json or set by hand) instead of being reset to `true`.
export const buildServers = (
  list: string[],
  slack: { keychain: string; addMessageTool: boolean; package?: SlackPackage } | null,
  { datadogSite = DEFAULT_DATADOG_SITE, nylas = null }: ServerOptions = {},
  prev?: Servers,
): Servers => {
  const out: Record<string, unknown> = {}
  const stored = (t: string): Record<string, unknown> => {
    const v = (prev as Record<string, unknown> | undefined)?.[t]
    return v && typeof v === "object" ? { ...(v as Record<string, unknown>) } : {}
  }
  for (const t of SERVER_TYPES) {
    if (t === "datadog") {
      if (!list.includes(t)) {
        out[t] = false
        continue
      }
      // Only persist a non-default site, so a US1 workspace stays `datadog: true`.
      const entry = stored(t)
      if (datadogSite === DEFAULT_DATADOG_SITE) delete entry.site
      else entry.site = datadogSite
      out[t] = Object.keys(entry).length ? entry : true
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
      const entry = stored(t)
      out[t] = list.includes(t) && (Object.keys(entry).length ? entry : true)
    }
  }
  return out as Servers
}

// The gh account picker shared by `add` and `edit`. `current` is the stored account
// when updating a workspace ("" for none); a stored account that `gh auth status`
// does not list (gh off PATH, logged out, a locked keyring) stays selectable and
// preselected, so pressing enter keeps it instead of silently switching the
// workspace to another account or to none. A new workspace (`current` undefined)
// preselects the first account, as before.
export const ghChoices = (accounts: string[], current?: string) => {
  const choices = accounts.map((a) => ({ label: a, value: a }))
  if (current && !accounts.includes(current))
    choices.unshift({ label: `${current} (not in gh auth status)`, value: current })
  choices.push({ label: "(none)", value: "" })
  const initial =
    current === undefined
      ? 0
      : Math.max(
          0,
          choices.findIndex((c) => c.value === current),
        )
  return { choices, initial }
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
  // The shared ~/.claude/skills is first-wins by workspace name, so a change that puts a
  // skill name another workspace already declares there from a different source (a
  // rename, turning isolation off) would silently swap one of them out. Refuse a clash
  // this change introduces; one that already existed is left for the user to resolve.
  const before = prior ? sharedNameClashes(cfg, prior) : []
  const introduced = sharedNameClashes(next, ws).filter((c) => !before.includes(c))
  if (introduced.length)
    throw new Error(
      `${introduced.join("\n")}\nRename the skill (\`inscope skill rename\`) or keep this workspace isolated; nothing was changed.`,
    )
  preflightApply(next) // refuse before the config is saved, not halfway through apply
  saveConfig(next)
  applyAll(next)
  // Relocated to a new path: applyAll only writes paths still in the config, so
  // prune the now-orphaned managed block from the old path's .mcp.json.
  if (prior && !sameMcpFile(prior.path, ws.path)) removeMcp(prior)
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

// The Claude login a workspace runs on, as picked at the add/edit prompt: the shared
// base, its own `.inscope`, or a named account. Offered as one choice once accounts
// exist; before that the prompt stays the plain "dedicated login?" yes/no.
export type LoginChoice = { isolate: boolean; account?: string }

export const loginChoices = (
  accounts: { name: string; email?: string }[],
  current: LoginChoice,
): { choices: { label: string; value: LoginChoice }[]; initial: number } => {
  const choices = [
    { label: "shared (your base login)", value: { isolate: false } as LoginChoice },
    { label: "isolated (its own login in .inscope)", value: { isolate: true } as LoginChoice },
    ...accounts.map((a) => ({
      label: `account ${a.name}${a.email ? ` (${a.email})` : ""}`,
      value: { isolate: false, account: a.name } as LoginChoice,
    })),
  ]
  const initial = current.account
    ? Math.max(0, 2 + accounts.findIndex((a) => a.name === current.account))
    : current.isolate
      ? 1
      : 0
  return { choices, initial }
}

// Resolve the --account / --isolate flags against the stored workspace. An account
// replaces isolation and vice versa; "none" (or an empty value) clears the account.
export const resolveLoginFlags = (
  flags: { account?: string; isolate?: boolean },
  existing: LoginChoice | undefined,
): LoginChoice => {
  let isolate = flags.isolate !== undefined ? flags.isolate : Boolean(existing?.isolate)
  let account = existing?.account
  if (flags.account !== undefined) {
    account = flags.account && flags.account !== "none" ? flags.account : undefined
    if (account) isolate = false
  }
  if (flags.isolate) account = undefined
  return { isolate, account }
}
