import fs from "node:fs"

import {
  adoptable,
  type Check,
  computeDrift,
  type Config,
  configExists,
  configPath,
  contractTilde,
  defaultRunner,
  type Drift,
  diffLines,
  loadConfig,
  mcpError,
  mcpFilePath,
  otherSkillLabel,
  otherSkillsIn,
  readMcp,
  renderServers,
  resolveAbsolute,
  resolveStatus,
  type Runner,
  runDoctor,
  SERVER_TYPES,
  skillLinked,
  skillsDir,
  sourceLabel,
  type Workspace,
  workspaceChecks,
  workspaceDrifts,
  workspaceSkills,
} from "inscope"

import { ApiError } from "@/lib/error"

// Every shape below is mapped field by field, rows A to Z and each response's subject first, so a field the library adds later never reaches the page unreviewed, and a token can only ever leave as a boolean.

// The config on disk, or null before the first `inscope add`; an invalid file is the user's to fix, so it surfaces as its own error rather than a 500.
export const readConfig = (): Config | null => {
  if (!configExists()) return null
  try {
    return loadConfig()
  } catch (err) {
    throw new ApiError(
      422,
      "INSCOPE_CONFIG_INVALID",
      err instanceof Error ? err.message : String(err),
    )
  }
}

export const findWorkspaceOrThrow = (
  cfg: Config | null,
  name: string,
): { cfg: Config; ws: Workspace } => {
  const ws = cfg?.workspaces.find((w) => w.name === name)
  if (!cfg || !ws) throw new ApiError(404, "NOT_FOUND", `No workspace named "${name}"`)
  return { cfg, ws }
}

// Redaction runs before the diff, on the parsed .mcp.json, so a credential is caught by where it sits rather than by how its line happens to look.

const REDACTED = "<redacted>"

// a key or flag whose name says it holds a credential
const CREDENTIAL_NAME = /auth|cookie|credential|key|pass|pwd|secret|token|(^|[-_])pat($|[-_])/i

// only names an environment variable, with at most an empty default (`${SLACK_MCP_XOXP_TOKEN:-}`), so it holds no secret
const ENV_REFERENCE = /^\$\{\w+(:-)?\}$/

// the query and the user info of every URL inside a string
export const redactUrls = (value: string): string =>
  value
    .replace(/\b(https?:\/\/)[^/\s@"']*@/gi, `$1${REDACTED}@`)
    .replace(/(\bhttps?:\/\/[^\s?#"']*\?)[^\s#"']+/gi, `$1${REDACTED}`)

const secret = (value: unknown): unknown =>
  typeof value === "string" && ENV_REFERENCE.test(value) ? value : REDACTED

const redactAll = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactAll)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactAll(child)]))
  return secret(value)
}

const redactArgs = (args: unknown[]): unknown[] =>
  args.map((arg, index) => {
    const previous = args[index - 1]
    if (
      typeof previous === "string" &&
      /^--?[\w-]+$/.test(previous) &&
      CREDENTIAL_NAME.test(previous)
    )
      return secret(arg)
    if (typeof arg !== "string") return redactValue(arg)
    const flag = arg.match(/^(--?[\w-]+)=/)
    if (flag && CREDENTIAL_NAME.test(flag[1])) return `${flag[0]}${REDACTED}`
    return redactUrls(arg)
  })

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactUrls(value)
  if (Array.isArray(value)) return redactArgs(value)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      // every value under env or headers is a credential until it only names a variable
      key === "env" || key === "headers" || CREDENTIAL_NAME.test(key)
        ? redactAll(child)
        : redactValue(child),
    ]),
  )
}

// A .mcp.json's text with every credential replaced, re-serialized the way apply writes it; text that does not parse is withheld whole.
export const redactMcpText = (text: string): string => {
  if (!text) return text
  try {
    return `${JSON.stringify(redactValue(JSON.parse(text)), null, 2)}\n`
  } catch {
    return REDACTED
  }
}

// the hook, git includes, and skill links hold no credential, only account names, emails, and paths
const driftRow = (cfg: Config, d: Drift) => {
  const isMcp = cfg.workspaces.some((ws) => mcpFilePath(ws) === d.path)
  const text = (value: string) => (isMcp ? redactMcpText(value) : value)
  return {
    diff: d.error ? null : diffLines(text(d.current), text(d.next)),
    error: d.error ?? null,
    label: d.label,
    path: contractTilde(d.path),
  }
}

const checkRow = (c: Check) => ({ detail: c.detail ?? null, label: c.label, status: c.status })

export const MCP_STATES = ["drifted", "in-sync", "invalid", "missing"] as const

const mcpState = (ws: Workspace, drifts: Drift[]): (typeof MCP_STATES)[number] => {
  if (mcpError(ws)) return "invalid"
  if (!fs.existsSync(mcpFilePath(ws))) return "missing"
  return drifts.some((d) => d.path === mcpFilePath(ws)) ? "drifted" : "in-sync"
}

// Server names only: the ones inscope writes for this workspace and any the user added by hand, and whether each is in the file yet.
const mcpServers = (ws: Workspace) => {
  if (mcpError(ws)) return []
  const managed = Object.keys(renderServers(ws))
  const onDisk = Object.keys(readMcp(ws)?.mcpServers ?? {})
  return [...new Set([...managed, ...onDisk])].sort().map((name) => ({
    managed: managed.includes(name),
    name,
    written: onDisk.includes(name),
  }))
}

const skillRows = (cfg: Config, ws: Workspace) => ({
  dir: contractTilde(skillsDir(ws)),
  other: otherSkillsIn(cfg, ws).map((o) => ({
    kind: o.kind,
    label: otherSkillLabel(o),
    name: o.name,
    target: o.kind === "own" ? (o.target ?? null) : null,
    workspace: o.kind === "workspace" ? o.workspace : null,
  })),
  own: workspaceSkills(ws).map(({ name, skill }) => ({
    linked: skillLinked(ws, name),
    name,
    source: skill ? sourceLabel(skill) : null,
  })),
})

const workspaceSummary = (cfg: Config, ws: Workspace, drifts: Drift[]) => ({
  gh: ws.gh ?? null,
  git: { email: ws.git?.email ?? null, name: ws.git?.name ?? null },
  isolated: ws.isolate === true,
  mcp: {
    error: mcpError(ws),
    path: contractTilde(mcpFilePath(ws)),
    servers: mcpServers(ws),
    state: mcpState(ws, drifts),
  },
  name: ws.name,
  path: ws.path,
  servers: SERVER_TYPES.filter((t) => Boolean((ws.servers as Record<string, unknown>)[t])),
  skills: skillRows(cfg, ws),
})

// What the config says and what is on disk; reads files only, never spawns a process.
export const overview = (cfg: Config | null) => {
  const config = {
    bypass: cfg?.bypass === true,
    exists: cfg !== null,
    path: contractTilde(configPath()),
  }
  if (!cfg) return { workspaces: [], config }
  const drifts = computeDrift(cfg)
  return { workspaces: cfg.workspaces.map((ws) => workspaceSummary(cfg, ws, drifts)), config }
}

// The identity each workspace resolves to, as `inscope status` run inside it would show; spawns claude, gh, and git through `run`.
const identity = (cfg: Config, ws: Workspace, run: Runner) => {
  const s = resolveStatus(cfg, { cwd: resolveAbsolute(ws.path), run })
  return {
    claude: {
      configDir: s.claude.configDir,
      email: s.claude.email ?? null,
      isolated: s.claude.isolated,
      org: s.claude.org ?? null,
      signedIn: s.claude.signedIn,
      subscription: s.claude.subscription ?? null,
    },
    git: { email: s.git.email, source: s.git.source },
    github: s.github ? { account: s.github.account, token: s.github.token } : null,
    name: ws.name,
  }
}

export const status = (cfg: Config | null, run: Runner = defaultRunner) => ({
  workspaces: cfg ? cfg.workspaces.map((ws) => identity(cfg, ws, run)) : [],
})

const summarize = (checks: Check[]) => ({
  fail: checks.filter((c) => c.status === "fail").length,
  ok: checks.filter((c) => c.status === "ok").length,
  warn: checks.filter((c) => c.status === "warn").length,
})

// `inscope doctor` without its "this shell" section, which describes the API process rather than any workspace.
export const doctor = (cfg: Config | null, run: Runner = defaultRunner) => {
  const checks = cfg ? runDoctor(cfg, run) : []
  return { checks: checks.map(checkRow), summary: summarize(checks) }
}

// What `inscope apply` would change, and what `inscope diff --adopt` would pull back into the config; an adopted value can be a URL, so its query and user info are redacted too.
export const diff = (cfg: Config | null) => {
  if (!cfg) return { drifts: [], adoptable: [] }
  return {
    drifts: computeDrift(cfg).map((d) => driftRow(cfg, d)),
    adoptable: adoptable(cfg).changes.map(redactUrls),
  }
}

// One workspace: its summary, the identity it resolves to, and the doctor checks and pending changes that belong to it.
export const workspaceDetail = (cfg: Config, ws: Workspace, run: Runner = defaultRunner) => {
  const drifts = computeDrift(cfg)
  return {
    workspace: workspaceSummary(cfg, ws, drifts),
    checks: workspaceChecks(runDoctor(cfg, run), ws).map(checkRow),
    drifts: workspaceDrifts(drifts, ws).map((d) => driftRow(cfg, d)),
    identity: identity(cfg, ws, run),
  }
}
