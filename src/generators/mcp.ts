import fs from "node:fs"
import path from "node:path"

import {
  DATADOG_SITES,
  type DatadogServer,
  type DatadogSite,
  DEFAULT_DATADOG_SITE,
  DEFAULT_SLACK_PACKAGE,
  type HttpServer,
  type NylasRegion,
  type NylasServer,
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

// Inverse of slackPackageSpec: which known package an on-disk slack server's
// npx args run, for `diff --adopt`. Matches by package name, ignoring the
// version/tag suffix, so it recognizes any pin (@latest, @1.3.0, bare). Returns
// null when no known slack package is found.
export const slackPackageFromArgs = (args: unknown): SlackPackage | null => {
  if (!Array.isArray(args)) return null
  const spec = args.find(
    (a): a is string => typeof a === "string" && a.includes("slack-mcp-server"),
  )
  if (!spec) return null
  // Anchor on a name boundary (exact, or immediately followed by @version) so a
  // sibling like "slack-mcp-server-fork@x" is not misread as the canonical package.
  const isPkg = (name: string) => spec === name || spec.startsWith(`${name}@`)
  if (isPkg("@nrjdalal/slack-mcp-server")) return "@nrjdalal/slack-mcp-server"
  if (isPkg("slack-mcp-server")) return "slack-mcp-server"
  return null
}

const GITHUB_URL = "https://api.githubcopilot.com/mcp/"

// A single-quoted shell literal: wrap in '...' and escape an embedded quote as
// '\'' so an arbitrary (already hook-validated) value can never break out of the
// command the headersHelper runs.
const shSingleQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

// Fetch the workspace's gh token at MCP-connect time and emit it as the auth
// header, so github auth works under ANY launcher (a shell, cmux, an IDE,
// `--resume`), not only one that inherited GITHUB_TOKEN from the chpwd hook. Claude
// Code runs this fresh on each connect (and re-runs it on a 401/403, retrying
// once). An offline/failed fetch yields an empty bearer, which fails just this
// server, not the whole .mcp.json (unlike a bare `${GITHUB_TOKEN}`, which makes
// Claude fail to parse the file when the var is unset). The token is interpolated
// raw via %s, so it assumes a shell/JSON-safe token; real gh tokens are
// [A-Za-z0-9_], the account (the untrusted part) is validated and single-quoted.
export const githubHeadersHelper = (account: string) =>
  `printf '{"Authorization":"Bearer %s"}' "$(gh auth token -u ${shSingleQuote(account)} 2>/dev/null)"`

// Fetch a Nylas API key from the macOS keychain at MCP-connect time and emit it
// as the Bearer header, like githubHeadersHelper: launcher-agnostic, and a missing
// key degrades just this server. The service is validated and single-quoted.
export const nylasHeadersHelper = (service: string) =>
  `printf '{"Authorization":"Bearer %s"}' "$(security find-generic-password -a "$USER" -s ${shSingleQuote(service)} -w 2>/dev/null)"`

export const nylasUrl = (region: NylasRegion = "us") => `https://mcp.${region}.nylas.com`

// Datadog's MCP endpoint for a regional site (US1 when unset).
export const datadogUrl = (site: DatadogSite = DEFAULT_DATADOG_SITE) => `https://mcp.${site}/v1/mcp`

// Remote servers Claude Code authenticates via OAuth over streamable HTTP
// (just a URL each; datadog's is its US1 default, see remoteUrl for the site).
export const REMOTE: Record<string, string> = {
  atlassian: "https://mcp.atlassian.com/v1/mcp",
  canva: "https://mcp.canva.com/mcp",
  clickup: "https://mcp.clickup.com/mcp",
  datadog: datadogUrl(),
  hubspot: "https://mcp.hubspot.com",
  intercom: "https://mcp.intercom.com/mcp",
  linear: "https://mcp.linear.app/mcp",
  monday: "https://mcp.monday.com/mcp",
  notion: "https://mcp.notion.com/mcp",
  plane: "https://mcp.plane.so/http/mcp",
  // one host for US and EU: PostHog's OAuth routes to the account's region
  posthog: "https://mcp.posthog.com/mcp",
  sentry: "https://mcp.sentry.dev/mcp",
  stripe: "https://mcp.stripe.com",
  vercel: "https://mcp.vercel.com",
  webflow: "https://mcp.webflow.com/",
  xquik: "https://xquik.com/mcp",
}

// github first (the primary identity), then the rest alphabetical
export const SERVER_TYPES = [
  "github",
  "atlassian",
  "canva",
  "clickup",
  "datadog",
  "hubspot",
  "intercom",
  "linear",
  "monday",
  "notion",
  "nylas",
  "plane",
  "posthog",
  "sentry",
  "slack",
  "stripe",
  "vercel",
  "webflow",
  "xquik",
] as const

export const managedKeys = (name: string) => SERVER_TYPES.map((t) => `${t}-${name}`)

export const mcpFilePath = (ws: Workspace) => path.join(resolveAbsolute(ws.path), ".mcp.json")

// Whether two workspace paths share one .mcp.json: the same file (device + inode,
// following symlinks, e.g. a worktree's .mcp.json linked to the main checkout's) or,
// before either file exists, the same directory (a symlinked spelling, or a different
// case on a case-insensitive volume). Relocating a workspace between such aliases must
// not prune the managed keys apply just wrote there.
export const sameMcpFile = (a: string, b: string): boolean => {
  const same = (x: string, y: string) => {
    try {
      const sx = fs.statSync(x)
      const sy = fs.statSync(y)
      return sx.dev === sy.dev && sx.ino === sy.ino
    } catch {
      return null
    }
  }
  const da = resolveAbsolute(a)
  const db = resolveAbsolute(b)
  if (da === db) return true
  return same(path.join(da, ".mcp.json"), path.join(db, ".mcp.json")) ?? same(da, db) ?? false
}

// The URL a configured remote server renders to: an explicit `url` wins, then
// datadog's regional site, then the server's default.
export const remoteUrl = (key: string, v: unknown): string => {
  const o: DatadogServer = v && typeof v === "object" ? v : {}
  if (o.url) return o.url
  if (key === "datadog") return datadogUrl(o.site)
  return REMOTE[key]
}

// Inverse of remoteUrl, for `diff --adopt`: the minimal config value that renders
// `url` (true for the default, a known datadog site as `site`, else a custom url).
export const remoteConfigFor = (key: string, url: string): true | HttpServer | DatadogServer => {
  if (url === REMOTE[key]) return true
  if (key === "datadog") {
    const site = DATADOG_SITES.find((s) => datadogUrl(s) === url)
    if (site) return { site }
  }
  return { url }
}

export const renderServers = (ws: Workspace): Record<string, unknown> => {
  const s = ws.servers as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of SERVER_TYPES) {
    const v = s[key]
    if (!v) continue
    const name = `${key}-${ws.name}`
    if (key === "github") {
      // With a gh account, fetch its token at connect via headersHelper (launcher
      // -agnostic). Without one, fall back to the ambient GITHUB_TOKEN, defaulted so
      // an unset var degrades this server instead of breaking the whole file.
      out[name] = ws.gh
        ? { type: "http", url: GITHUB_URL, headersHelper: githubHeadersHelper(ws.gh) }
        : { type: "http", url: GITHUB_URL, headers: { Authorization: "Bearer ${GITHUB_TOKEN:-}" } }
    } else if (key === "nylas") {
      const nylas = v as NylasServer
      out[name] = {
        type: "http",
        url: nylasUrl(nylas.region),
        headersHelper: nylasHeadersHelper(nylas.keychain),
      }
    } else if (key === "slack") {
      const slack = v as SlackServer
      const pkg = slack.package ?? DEFAULT_SLACK_PACKAGE
      // Defaulted (`:-`) so a launcher that never ran the chpwd hook (a shell-less
      // cmux/IDE launch) gets an empty token and a degraded slack server, rather
      // than an unset-var parse error that would take down every server in the file.
      // A shell launch still gets the real token, which the hook exports on cd.
      const env: Record<string, string> = {
        SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN:-}",
      }
      const args = ["-y", slackPackageSpec(pkg)]
      if (pkg === "@nrjdalal/slack-mcp-server") {
        // The fork speaks stdio by default (no --transport flag) and is
        // write-enabled by default; read-only is opt-in via
        // SLACK_MCP_ALLOW_WRITE=false. So addMessageTool ("allow posting") maps to
        // the absence of that opt-out: true leaves the default, false disables write.
        if (!slack.addMessageTool) env.SLACK_MCP_ALLOW_WRITE = "false"
      } else {
        // korotovsky: opt into the stdio transport and the post-message tool.
        args.push("--transport", "stdio")
        if (slack.addMessageTool) env.SLACK_MCP_ADD_MESSAGE_TOOL = "true"
      }
      out[name] = { type: "stdio", command: "npx", args, env }
    } else {
      out[name] = { type: "http", url: remoteUrl(key, v) }
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
