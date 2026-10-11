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
  if (!cfg || !ws)
    throw new ApiError(404, "INSCOPE_WORKSPACE_NOT_FOUND", `No workspace named "${name}"`)
  return { cfg, ws }
}

// Redaction runs before the diff, on the parsed .mcp.json, so a credential is caught by where it sits rather than by how its line happens to look.

const REDACTED = "<redacted>"

// words that name a credential on their own, and longer ones that do even inside a word ("dbpassword", "githubToken")
const CREDENTIAL_WORDS = new Set([
  "auth",
  "authorization",
  "connection",
  "cookie",
  "dsn",
  "key",
  "pass",
  "pat",
  "pwd",
])
const CREDENTIAL_PARTS = ["apikey", "credential", "passwd", "password", "secret", "token"]

// A key, flag, header, or variable whose name says it holds a credential, judged per word of the name (camelCase, snake_case, kebab-case), so `apiKey`, `DB_PASSWORD`, and `X-Api-Key` count while `keycloak`, `oauth`, and `clientId` do not.
export const isCredentialName = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .some(
      (word) => CREDENTIAL_WORDS.has(word) || CREDENTIAL_PARTS.some((part) => word.includes(part)),
    )

// only names an environment variable, with at most an empty default (`${SLACK_MCP_XOXP_TOKEN:-}`), or is a plain toggle, so it holds no secret
const NOT_SECRET = /^(\$\{\w+(:-)?\}|true|false|on|off|yes|no)$/i

// a value filled in at run time (`Bearer %s`, `${TOKEN}`, `$(gh auth token)`), or already withheld, is not a credential itself
const FILLED_LATER = /%s|\$\{|\$\(|<redacted>/

const URL_START = String.raw`\b[a-z][a-z0-9+.-]*:\/\/`
const AUTH_SCHEMES = "Basic|Bearer|Token"

// A string that holds JSON (`--config '{"apiKey": "..."}'`) is redacted by structure like the file around it.
const redactJsonText = (value: string): string | null => {
  if (!/^\s*[[{]/.test(value)) return null
  try {
    return JSON.stringify(redactValue(JSON.parse(value)))
  } catch {
    return null
  }
}

// A `Name: value` header whose name says credential, withheld to the end of its line (`Cookie: a=x; b=y`); each name on a line is judged, so an earlier, harmless one cannot hide it.
const redactHeaders = (value: string): string => {
  let out = ""
  let done = 0
  for (const match of value.matchAll(/\b([A-Za-z_][\w.-]*)\s*:(?!\/\/)\s*/g)) {
    if (match.index < done || !isCredentialName(match[1])) continue
    const start = match.index + match[0].length
    const length = value.slice(start).search(/[\r\n"']/)
    const end = length === -1 ? value.length : start + length
    if (FILLED_LATER.test(value.slice(start, end))) continue
    out += `${value.slice(done, start)}${REDACTED}`
    done = end
  }
  return out + value.slice(done)
}

// Every credential a free string can carry by its shape: the user info, query, and fragment of a URL in any scheme (postgresql://user:pw@, wss://, ?token=, #access_token=), an HTTP auth scheme's token in any case, a quoted JSON pair, a `name=value`, and a `Name: value` header whose name says credential, the header to the end of its line.
export const redactString = (value: string): string =>
  redactJsonText(value) ??
  redactHeaders(value)
    .replace(new RegExp(`(${URL_START})[^\\s"'@/]*:[^\\s"']*@`, "gi"), `$1${REDACTED}@`)
    .replace(new RegExp(`(${URL_START})[^\\s"'@/:]*@`, "gi"), `$1${REDACTED}@`)
    .replace(new RegExp(`(${URL_START}[^\\s?#"']*\\?)[^\\s#"']+`, "gi"), `$1${REDACTED}`)
    .replace(new RegExp(`(${URL_START}[^\\s#"']*#)[^\\s"']+`, "gi"), `$1${REDACTED}`)
    .replace(new RegExp(`\\b(${AUTH_SCHEMES})\\s+[\\w.~+/=-]{8,}`, "gi"), `$1 ${REDACTED}`)
    .replace(
      /"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
      (pair: string, name: string, separator: string, inner: string) =>
        isCredentialName(name) && !FILLED_LATER.test(inner)
          ? `"${name}"${separator}"${REDACTED}"`
          : pair,
    )
    .replace(
      /\b([A-Za-z_][\w.-]*)(\s*=\s*)([^\s,;&"']+)/g,
      (pair: string, name: string, separator: string, inner: string) =>
        isCredentialName(name) && !FILLED_LATER.test(inner)
          ? `${name}${separator}${REDACTED}`
          : pair,
    )

const secret = (value: unknown): unknown =>
  typeof value === "string" && NOT_SECRET.test(value) ? value : REDACTED

const redactAll = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactAll)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactAll(child)]))
  return secret(value)
}

const ENV_FLAGS = new Set(["-e", "--env"])

// A command line: the value after a credential flag (`--api-key x`), and the value of a `KEY=value` passed to `-e`/`--env` (docker), whatever its name and in either `--env K=V` or `--env=K=V` form; every other argument goes through redactString.
const redactArgs = (args: unknown[]): unknown[] =>
  args.map((arg, index) => {
    const previous = args[index - 1]
    const flag = typeof previous === "string" && /^--?[\w-]+$/.test(previous) ? previous : ""
    if (flag && isCredentialName(flag)) return secret(arg)
    if (typeof arg !== "string") return redactValue(arg)
    const variable = arg.match(/^([\w.-]+)=/)
    if (variable && ENV_FLAGS.has(flag)) return `${variable[0]}${REDACTED}`
    const inline = arg.match(/^(--?env=[\w.-]+=)/)
    if (inline) return `${inline[1]}${REDACTED}`
    return redactString(arg)
  })

// mcpServers' own keys are server names (`keycloak`, `auth0`), not settings, so the name rule starts one level below them
const redactServers = (servers: unknown): unknown =>
  servers !== null && typeof servers === "object" && !Array.isArray(servers)
    ? Object.fromEntries(
        Object.entries(servers).map(([name, server]) => [name, redactValue(server)]),
      )
    : redactValue(servers)

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return redactArgs(value)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "mcpServers"
        ? redactServers(child)
        : // every value under env or headers is a credential until it only names a variable or is a plain toggle
          key === "env" || key === "headers" || isCredentialName(key)
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

const mcpState = (
  error: string | null,
  exists: boolean,
  drifted: boolean,
): (typeof MCP_STATES)[number] => {
  if (error) return "invalid"
  if (!exists) return "missing"
  return drifted ? "drifted" : "in-sync"
}

// A workspace's .mcp.json as the dashboard shows it, read and parsed once (the library words the error when it does not parse): its state, the server names in it (inscope's own and any added by hand, and whether each is written yet), and the server types the config enables.
const mcpSummary = (ws: Workspace, drifts: Drift[]) => {
  const file = mcpFilePath(ws)
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
  let onDisk: string[] = []
  let error: string | null = null
  if (text !== null) {
    try {
      onDisk = Object.keys(JSON.parse(text).mcpServers ?? {})
    } catch {
      error = mcpError(ws)
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

// What `inscope apply` would change, and what `inscope diff --adopt` would pull back into the config; an adopted value can be a URL or a credential, so it goes through redactString too.
export const diff = (cfg: Config | null) => {
  if (!cfg) return { drifts: [], adoptable: [] }
  return {
    drifts: computeDrift(cfg).map((d) => driftRow(cfg, d)),
    adoptable: adoptable(cfg).changes.map(redactString),
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
