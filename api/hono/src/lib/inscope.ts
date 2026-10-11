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

// a key, flag, or variable whose name says it holds a credential
const CREDENTIAL_NAME =
  /auth|connection|cookie|credential|dsn|key|pass|pwd|secret|token|(^|[-_])pat($|[-_])/i

// only names an environment variable, with at most an empty default (`${SLACK_MCP_XOXP_TOKEN:-}`), so it holds no secret
const ENV_REFERENCE = /^\$\{\w+(:-)?\}$/

const URL_START = String.raw`\b[a-z][a-z0-9+.-]*:\/\/`

// Every credential a free string can carry by its shape: the user info, query, and fragment of a URL in any scheme (postgresql://user:pw@, wss://, ?token=, #access_token=), an HTTP auth scheme's token, and the value of a `name=value` or `Name: value` pair whose name says credential.
export const redactStrings = (value: string): string =>
  value
    .replace(new RegExp(`(${URL_START})[^/\\s@"']*@`, "gi"), `$1${REDACTED}@`)
    .replace(new RegExp(`(${URL_START}[^\\s?#"']*\\?)[^\\s#"']+`, "gi"), `$1${REDACTED}`)
    .replace(new RegExp(`(${URL_START}[^\\s#"']*#)[^\\s"']+`, "gi"), `$1${REDACTED}`)
    .replace(/\b(Basic|Bearer|Token)\s+[\w.~+/=-]{8,}/g, `$1 ${REDACTED}`)
    .replace(
      /\b([A-Za-z_][\w.-]*)(\s*=\s*|\s*:\s+)(?!(?:Basic|Bearer|Token)\b)([^\s,;&"']+)/g,
      (pair: string, name: string, separator: string) =>
        CREDENTIAL_NAME.test(name) ? `${name}${separator}${REDACTED}` : pair,
    )

const secret = (value: unknown): unknown =>
  typeof value === "string" && ENV_REFERENCE.test(value) ? value : REDACTED

const redactAll = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactAll)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactAll(child)]))
  return secret(value)
}

// A command line: the value after a credential flag (`--api-key x`), and the value of a `KEY=value` passed to `-e`/`--env` (docker), whatever its name; every other argument goes through redactStrings.
const redactArgs = (args: unknown[]): unknown[] =>
  args.map((arg, index) => {
    const previous = args[index - 1]
    const flag = typeof previous === "string" && /^--?[\w-]+$/.test(previous) ? previous : ""
    if (flag && CREDENTIAL_NAME.test(flag)) return secret(arg)
    if (typeof arg !== "string") return redactValue(arg)
    const variable = arg.match(/^([\w.-]+)=/)
    if (variable && (flag === "-e" || flag === "--env")) return `${variable[0]}${REDACTED}`
    return redactStrings(arg)
  })

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactStrings(value)
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

// A workspace's .mcp.json as the dashboard shows it, read and parsed once: whether it is in sync, the server names in it (inscope's own and any added by hand, and whether each is written yet), and the server types the config enables.
const mcpBlock = (ws: Workspace, drifts: Drift[]) => {
  const file = mcpFilePath(ws)
  const error = mcpError(ws)
  const exists = fs.existsSync(file)
  const managed = Object.keys(renderServers(ws))
  const onDisk = error || !exists ? [] : Object.keys(readMcp(ws)?.mcpServers ?? {})
  const state: (typeof MCP_STATES)[number] = error
    ? "invalid"
    : !exists
      ? "missing"
      : drifts.some((d) => d.path === file)
        ? "drifted"
        : "in-sync"
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
    state,
    types: SERVER_TYPES.filter((t) => Boolean(ws.servers[t])),
  }
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
  mcp: mcpBlock(ws, drifts),
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

// What `inscope apply` would change, and what `inscope diff --adopt` would pull back into the config; an adopted value can be a URL or a credential, so it goes through redactStrings too.
export const diff = (cfg: Config | null) => {
  if (!cfg) return { drifts: [], adoptable: [] }
  return {
    drifts: computeDrift(cfg).map((d) => driftRow(cfg, d)),
    adoptable: adoptable(cfg).changes.map(redactStrings),
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
