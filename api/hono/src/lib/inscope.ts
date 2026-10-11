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
  diffLines,
  loadConfig,
  mcpError,
  mcpFilePath,
  otherSkillLabel,
  otherSkillsIn,
  resolveAbsolute,
  resolveStatus,
  type Runner,
  runDoctor,
  SERVER_TYPES,
  skillLinked,
  skillsDir,
  sourceLabel,
  type Workspace,
  workspaceSkills,
} from "inscope"

import { ApiError } from "@/lib/error"

// Every shape below is mapped field by field, so a field the library adds later never reaches the page unreviewed, and a token can only ever leave as a boolean.

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

export const findWorkspaceOrThrow = (cfg: Config | null, name: string): Workspace => {
  const ws = cfg?.workspaces.find((w) => w.name === name)
  if (!ws) throw new ApiError(404, "NOT_FOUND", `No workspace named "${name}"`)
  return ws
}

const enabledServers = (ws: Workspace): string[] =>
  SERVER_TYPES.filter((t) => Boolean((ws.servers as Record<string, unknown>)[t]))

export type McpState = "drifted" | "in-sync" | "invalid" | "missing"

const mcpState = (ws: Workspace, drifted: Set<string>): McpState => {
  if (mcpError(ws)) return "invalid"
  if (!fs.existsSync(mcpFilePath(ws))) return "missing"
  return drifted.has(`mcp:${ws.name}`) ? "drifted" : "in-sync"
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

const workspaceSummary = (cfg: Config, ws: Workspace, drifted: Set<string>) => ({
  name: ws.name,
  gh: ws.gh ?? null,
  git: { email: ws.git?.email ?? null, name: ws.git?.name ?? null },
  isolated: ws.isolate === true,
  mcp: { error: mcpError(ws), path: contractTilde(mcpFilePath(ws)), state: mcpState(ws, drifted) },
  path: ws.path,
  servers: enabledServers(ws),
  skills: skillRows(cfg, ws),
})

const driftLabels = (cfg: Config) => new Set(computeDrift(cfg).map((d) => d.label))

// What the config says and what is on disk; reads files only, never spawns a process.
export const overview = (cfg: Config | null) => {
  const drifted = cfg ? driftLabels(cfg) : new Set<string>()
  return {
    config: {
      bypass: cfg?.bypass === true,
      exists: cfg !== null,
      path: contractTilde(configPath()),
    },
    workspaces: (cfg?.workspaces ?? []).map((ws) => workspaceSummary(cfg as Config, ws, drifted)),
  }
}

// The identity each workspace resolves to, as `inscope status` run inside it would show; spawns claude, gh, and git through `run`.
const identity = (cfg: Config, ws: Workspace, run: Runner) => {
  const s = resolveStatus(cfg, { cwd: resolveAbsolute(ws.path), run })
  return {
    name: ws.name,
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
  }
}

export const status = (cfg: Config | null, run: Runner = defaultRunner) => ({
  workspaces: (cfg?.workspaces ?? []).map((ws) => identity(cfg as Config, ws, run)),
})

const checkRow = (c: Check) => ({ detail: c.detail ?? null, label: c.label, status: c.status })

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

// A value whose key names a credential, on a JSON or KEY=VALUE line; a hand-written server in .mcp.json can hold a literal key, and the page must not.
const SECRET_LINE =
  /^([-+ ] *"?[\w.-]*(?:authorization|key|password|secret|token)[\w.-]*"?\s*[:=]\s*)(.+?)(,?)$/i

// a value that only names an environment variable (`${SLACK_MCP_XOXP_TOKEN:-}`) holds no secret, so it stays readable
const ENV_REFERENCE = /^"\$\{\w+(:-[^}]*)?\}"$/

export const redact = (diff: string): string =>
  diff
    .split("\n")
    .map((line) =>
      line.replace(SECRET_LINE, (whole: string, head: string, value: string, comma: string) =>
        ENV_REFERENCE.test(value) ? whole : `${head}"<redacted>"${comma}`,
      ),
    )
    .join("\n")

const driftRow = (d: ReturnType<typeof computeDrift>[number]) => ({
  label: d.label,
  diff: d.error ? null : redact(diffLines(d.current, d.next)),
  error: d.error ?? null,
  path: contractTilde(d.path),
})

// What `inscope apply` would change, and what `inscope diff --adopt` would pull back into the config.
export const diff = (cfg: Config | null) => ({
  adoptable: cfg ? adoptable(cfg).changes : [],
  drifts: cfg ? computeDrift(cfg).map(driftRow) : [],
})

// One workspace: its summary, the identity it resolves to, and the doctor checks and drifts tagged with its name.
export const workspaceDetail = (cfg: Config, ws: Workspace, run: Runner = defaultRunner) => {
  const drifts = computeDrift(cfg)
  // the shared ~/.claude/skills drift is labelled "personal" and belongs to every workspace that is not isolated
  const labels = new Set([
    `gitconfig:${ws.name}`,
    `mcp:${ws.name}`,
    `skills:${ws.isolate ? ws.name : "personal"}`,
  ])
  const mine = (label: string) => labels.has(label)
  const checks = runDoctor(cfg, run).filter((c) => c.label.startsWith(`[${ws.name}] `))
  return {
    workspace: workspaceSummary(cfg, ws, new Set(drifts.map((d) => d.label))),
    checks: checks.map(checkRow),
    drifts: drifts.filter((d) => mine(d.label)).map(driftRow),
    identity: identity(cfg, ws, run),
  }
}
