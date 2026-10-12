import fs from "node:fs"

import {
  adoptable,
  type Check,
  computeDrift,
  type Config,
  configExists,
  configPath,
  contractTilde,
  type Drift,
  diffLines,
  loadConfig,
  MCP_INVALID_JSON,
  mcpFilePath,
  otherSkillLabel,
  otherSkillsIn,
  renderServers,
  resolveAbsolute,
  resolveStatus,
  runDoctor,
  SERVER_TYPES,
  skillLinked,
  skillsDir,
  type Workspace,
  workspaceChecks,
  workspaceDrifts,
  workspaceSkills,
} from "inscope"

import { ApiError } from "@/lib/error"
import { redactMcpText, redactSkillPaths, redactString, skillSourceLabel } from "@/lib/redact"

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
  if (!cfg || !ws)
    throw new ApiError(404, "INSCOPE_WORKSPACE_NOT_FOUND", `No workspace named "${name}"`)
  return { cfg, ws }
}

// an .mcp.json is redacted by structure; the hook, git includes, and skill links by the string rules, since a hand edit can put a credential anywhere (a git include's `[url "https://user:token@host/"]`), and a skill link's git cache folder by redactSkillPaths
const driftRow = (cfg: Config, d: Drift) => {
  const isMcp = cfg.workspaces.some((ws) => mcpFilePath(ws) === d.path)
  const paths = redactSkillPaths(cfg)
  const text = isMcp ? redactMcpText : (value: string) => paths(redactString(value))
  return {
    diff: d.error ? null : diffLines(text(d.current), text(d.next)),
    error: d.error ?? null,
    label: d.label,
    path: contractTilde(d.path),
  }
}

// a skill check can name a link's target, which may be a git skill's cache folder
const checkRows = (cfg: Config, checks: Check[]) => {
  const paths = redactSkillPaths(cfg)
  return checks.map((c) => ({
    detail: c.detail ? paths(c.detail) : null,
    label: c.label,
    status: c.status,
  }))
}

export const MCP_STATES = ["drifted", "in-sync", "invalid", "missing"] as const

const mcpState = (
  error: string | null,
  exists: boolean,
  drifted: boolean,
): (typeof MCP_STATES)[number] => {
  if (error) return "invalid"
  if (!exists) return "missing"
  return drifted ? "drifted" : "in-sync"
}

// A workspace's .mcp.json as the dashboard shows it, read and parsed once: its state, the server names in it (inscope's own and any added by hand, and whether each is written yet), and the server types the config enables.
const mcpSummary = (ws: Workspace, drifts: Drift[]) => {
  const file = mcpFilePath(ws)
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
  let onDisk: string[] = []
  let error: string | null = null
  if (text !== null) {
    try {
      onDisk = Object.keys(JSON.parse(text).mcpServers ?? {})
    } catch {
      error = MCP_INVALID_JSON
    }
  }
  const managed = Object.keys(renderServers(ws))
  return {
    error,
    path: contractTilde(file),
    servers: error
      ? []
      : [...new Set([...managed, ...onDisk])].sort().map((name) => ({
          managed: managed.includes(name),
          name,
          written: onDisk.includes(name),
        })),
    state: mcpState(
      error,
      text !== null,
      drifts.some((d) => d.path === file),
    ),
    types: SERVER_TYPES.filter((t) => Boolean(ws.servers[t])),
  }
}

// a git source's URL and a link into its cache folder can both carry a credential
const skillRows = (cfg: Config, ws: Workspace) => {
  const paths = redactSkillPaths(cfg)
  return {
    dir: contractTilde(skillsDir(ws)),
    other: otherSkillsIn(cfg, ws).map((o) => ({
      kind: o.kind,
      label: paths(otherSkillLabel(o)),
      name: o.name,
      target: o.kind === "own" && o.target ? paths(o.target) : null,
      workspace: o.kind === "workspace" ? o.workspace : null,
    })),
    own: workspaceSkills(ws).map(({ name, skill }) => ({
      linked: skillLinked(ws, name),
      name,
      source: skill ? skillSourceLabel(skill) : null,
    })),
  }
}

const workspaceSummary = (cfg: Config, ws: Workspace, drifts: Drift[]) => ({
  gh: ws.gh ?? null,
  git: { email: ws.git?.email ?? null, name: ws.git?.name ?? null },
  isolated: ws.isolate === true,
  mcp: mcpSummary(ws, drifts),
  name: ws.name,
  path: ws.path,
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

// The identity each workspace resolves to, as `inscope status` run inside it would show; spawns claude, gh, and git.
const identity = (cfg: Config, ws: Workspace) => {
  const s = resolveStatus(cfg, { cwd: resolveAbsolute(ws.path) })
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

export const status = (cfg: Config | null) => ({
  workspaces: cfg ? cfg.workspaces.map((ws) => identity(cfg, ws)) : [],
})

const summarize = (checks: Check[]) => ({
  fail: checks.filter((c) => c.status === "fail").length,
  ok: checks.filter((c) => c.status === "ok").length,
  warn: checks.filter((c) => c.status === "warn").length,
})

// `inscope doctor` without its "this shell" section, which describes the API process rather than any workspace.
export const doctor = (cfg: Config | null) => {
  const checks = cfg ? runDoctor(cfg) : []
  return { checks: cfg ? checkRows(cfg, checks) : [], summary: summarize(checks) }
}

// What `inscope apply` would change, and what `inscope diff --adopt` would pull back into the config; an adopted value can be a URL or a credential, so it goes through redactString too.
export const diff = (cfg: Config | null) => {
  if (!cfg) return { drifts: [], adoptable: [] }
  return {
    drifts: computeDrift(cfg).map((d) => driftRow(cfg, d)),
    adoptable: adoptable(cfg).changes.map(redactString),
  }
}

// One workspace: its summary, the identity it resolves to, and the doctor checks and pending changes that belong to it.
export const workspaceDetail = (cfg: Config, ws: Workspace) => {
  const drifts = computeDrift(cfg)
  return {
    workspace: workspaceSummary(cfg, ws, drifts),
    checks: checkRows(cfg, workspaceChecks(runDoctor(cfg), ws)),
    drifts: workspaceDrifts(drifts, ws).map((d) => driftRow(cfg, d)),
    identity: identity(cfg, ws),
  }
}
