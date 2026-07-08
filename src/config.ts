import fs from "node:fs"
import path from "node:path"

import { configPath, contractTilde, resolveAbsolute } from "@/env"
import { writeFileAtomic } from "@/io"

// The Slack MCP server package a workspace runs. The @nrjdalal fork is the
// default and floats on @latest; the original (korotovsky) is pinned for
// reproducibility and selectable via `package: "slack-mcp-server"` (see
// slackPackageSpec in generators/mcp.ts). Omitting `package` means the default,
// so configs without it render the @nrjdalal fork on @latest.
export const SLACK_PACKAGES = ["slack-mcp-server", "@nrjdalal/slack-mcp-server"] as const

export type SlackPackage = (typeof SLACK_PACKAGES)[number]

export const DEFAULT_SLACK_PACKAGE: SlackPackage = "@nrjdalal/slack-mcp-server"

export type SlackServer = { keychain: string; addMessageTool?: boolean; package?: SlackPackage }

export type HttpServer = { url?: string }

export type Servers = {
  github?: boolean
  atlassian?: boolean | HttpServer
  canva?: boolean | HttpServer
  clickup?: boolean | HttpServer
  hubspot?: boolean | HttpServer
  intercom?: boolean | HttpServer
  linear?: boolean | HttpServer
  monday?: boolean | HttpServer
  notion?: boolean | HttpServer
  plane?: boolean | HttpServer
  sentry?: boolean | HttpServer
  slack?: SlackServer | false
  stripe?: boolean | HttpServer
  vercel?: boolean | HttpServer
  webflow?: boolean | HttpServer
}

export type Workspace = {
  // Give this workspace its own Claude Code login: apply scaffolds a
  // workspace-local config dir at `<path>/.inscope` and the generated `claude()`
  // wrapper points CLAUDE_CONFIG_DIR there when you launch from this subtree. Omit
  // to run on the shared ~/.claude like every unmapped directory. Kept first so an
  // isolated workspace is flagged at the top of its block in inscope.json.
  isolate?: boolean
  name: string
  path: string
  gh?: string
  git?: { email?: string; name?: string }
  servers: Servers
}

// Launch behavior for the generated `claude()` wrapper, independent of per-workspace
// `isolate` (which only sets the login dir). `true` enables only `claude update`;
// `--dangerously-skip-permissions` is dangerous (CLI-only, no settings equivalent),
// so it is opt-in via the object form and never implied by a terse `true`. An object
// opts each flag in individually (omitted = off); absent/false adds no flags.
export type ClaudeLaunch = boolean | { update?: boolean; dangerouslySkipPermissions?: boolean }

export type Config = {
  version: number
  // Global `claude()` launch flags: `claude update` before each launch and/or
  // `--dangerously-skip-permissions` (see ClaudeLaunch).
  claude?: ClaudeLaunch
  workspaces: Workspace[]
}

export const CONFIG_VERSION = 1

// Normalize the top-level `claude` launch config into concrete flags, or null when
// the wrapper needs none. `true` enables only the safe `update` flag; bypassing
// permissions must be opted into explicitly via the object form, never implied by a
// terse `true`. Shared by the hook generator and validation.
export const resolveClaudeLaunch = (
  cfg: Config,
): { update: boolean; dangerouslySkipPermissions: boolean } | null => {
  const c = cfg.claude
  if (c === undefined || c === false) return null
  if (c === true) return { update: true, dangerouslySkipPermissions: false }
  return {
    update: c.update ?? false,
    dangerouslySkipPermissions: c.dangerouslySkipPermissions ?? false,
  }
}

export const defaultConfig = (): Config => ({
  version: CONFIG_VERSION,
  workspaces: [],
})

export const configExists = () => fs.existsSync(configPath())

export const loadConfig = (): Config => {
  const file = configPath()
  const raw = fs.readFileSync(file, "utf8")
  // A raw JSON.parse throws "Unexpected EOF" with no path; match the friendly,
  // path-hinted framing the validation errors below already use.
  let parsed: Config
  try {
    parsed = JSON.parse(raw) as Config
  } catch {
    throw new Error(`${contractTilde(file)} is not valid JSON; fix it, then re-run.`)
  }
  // A too-new config is fixed by upgrading inscope, not by editing the file, so
  // surface it on its own rather than under the generic "fix it and re-run".
  const versionErr = configVersionError(parsed)
  if (versionErr) throw new Error(versionErr)
  try {
    validateConfig(parsed)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${msg}\nFix it in ${contractTilde(file)}, then re-run.`)
  }
  return parsed
}

export const saveConfig = (cfg: Config) => {
  // Validate at the write boundary so every path that persists config (add,
  // edit, init, remove, diff --adopt) is guarded by construction, not by each
  // caller remembering to validate first.
  validateConfig(cfg)
  const file = configPath()
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + "\n")
}

// A workspace name is interpolated into the generated zsh hook as a `case`
// label (which cannot be safely quoted) and used as a filename
// (`<name>.gitconfig`), so it must be a plain slug: no whitespace, shell
// metacharacters, or path separators.
export const WORKSPACE_NAME_RE = /^[A-Za-z0-9._-]+$/

export const workspaceNameError = (name: string): string | null => {
  if (!name) return "must not be empty"
  if (!WORKSPACE_NAME_RE.test(name))
    return "use only letters, digits, dot (.), dash (-), or underscore (_)"
  return null
}

// Every value interpolated into the generated zsh hook is double-quoted, but
// zsh still treats several characters as significant inside double quotes:
// $-expansion, $(...)/`...` command substitution, and a backslash, which
// escapes the next character (a trailing one escapes the closing quote and
// produces an unsourceable hook, since gh/keychain arms put the quote directly
// after the value). So these must be rejected wherever a value reaches the hook
// (workspace path, gh account, Slack keychain service), not just quoted. The
// workspace name is handled separately (WORKSPACE_NAME_RE) because it also
// appears as an unquotable `case` pattern.
const HOOK_UNSAFE = /[\\"`$\n]/

export const hookValueError = (value: string): string | null =>
  HOOK_UNSAFE.test(value)
    ? 'must not contain a backslash (\\), quote ("), backtick (`), $, or newline'
    : null

// The path is interpolated into the hook's `case` pattern; spaces are fine
// (the pattern is quoted) but the breakout set above is not.
export const workspacePathError = (p: string): string | null => {
  if (!p) return "must not be empty"
  return hookValueError(p)
}

// git.email / git.name are written verbatim into the per-workspace gitconfig,
// which is pulled into every repo under the path via `includeIf gitdir:`. A
// newline lets a value inject arbitrary git config (e.g. `[core] sshCommand =`,
// which runs on git network ops), so reject CR/LF. Other characters are fine:
// gitconfig is line-based, so only a real line break can start a new key.
export const gitValueError = (value: string): string | null =>
  /[\n\r]/.test(value) ? "must not contain a newline" : null

// Forward-compat guard: refuse a config written by a newer inscope rather than
// mis-parsing its shape silently. A missing/older version is tolerated (any
// future migration owns that), so only a strictly-newer version is rejected.
export const configVersionError = (cfg: Config): string | null =>
  typeof cfg.version === "number" && cfg.version > CONFIG_VERSION
    ? `config version ${cfg.version} is newer than this inscope supports (max ${CONFIG_VERSION}); upgrade inscope`
    : null

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")

export const validateConfig = (cfg: Config) => {
  if (!cfg || typeof cfg !== "object") throw new Error("config is not an object")
  const versionErr = configVersionError(cfg)
  if (versionErr) throw new Error(versionErr)
  if (!Array.isArray(cfg.workspaces)) throw new Error("config.workspaces must be an array")
  if (cfg.claude !== undefined && typeof cfg.claude !== "boolean") {
    const c = cfg.claude
    if (c === null || typeof c !== "object" || Array.isArray(c))
      throw new Error("config claude must be a boolean or an object")
    for (const k of Object.keys(c)) {
      if (k !== "update" && k !== "dangerouslySkipPermissions")
        throw new Error(`config claude has unknown key "${k}"`)
      if (
        (c as Record<string, unknown>)[k] !== undefined &&
        typeof (c as Record<string, unknown>)[k] !== "boolean"
      )
        throw new Error(`config claude.${k} must be a boolean`)
    }
  }
  const seen = new Set<string>()
  for (const ws of cfg.workspaces) {
    if (!ws.name) throw new Error("a workspace is missing a name")
    const nameErr = workspaceNameError(ws.name)
    if (nameErr) throw new Error(`workspace name "${ws.name}" is invalid: ${nameErr}`)
    if (!ws.path) throw new Error(`workspace "${ws.name}" is missing a path`)
    const pathErr = workspacePathError(ws.path)
    if (pathErr) throw new Error(`workspace "${ws.name}" path "${ws.path}" is invalid: ${pathErr}`)
    if (ws.gh) {
      const ghErr = hookValueError(ws.gh)
      if (ghErr)
        throw new Error(`workspace "${ws.name}" gh account "${ws.gh}" is invalid: ${ghErr}`)
    }
    if (ws.isolate !== undefined && typeof ws.isolate !== "boolean")
      throw new Error(`workspace "${ws.name}" isolate must be a boolean`)
    if (ws.git?.email) {
      const emailErr = gitValueError(ws.git.email)
      if (emailErr)
        throw new Error(
          `workspace "${ws.name}" git email "${ws.git.email}" is invalid: ${emailErr}`,
        )
    }
    if (ws.git?.name) {
      const gitNameErr = gitValueError(ws.git.name)
      if (gitNameErr)
        throw new Error(
          `workspace "${ws.name}" git name "${ws.git.name}" is invalid: ${gitNameErr}`,
        )
    }
    const slack = ws.servers?.slack
    if (slack && slack.keychain) {
      const kcErr = hookValueError(slack.keychain)
      if (kcErr)
        throw new Error(
          `workspace "${ws.name}" Slack keychain "${slack.keychain}" is invalid: ${kcErr}`,
        )
    }
    // package picks the npm package npx runs, so restrict it to the known set: a
    // hand-edited config can't point it at an arbitrary (code-executing) package.
    const slackPkg = slack && (slack as { package?: string }).package
    if (slackPkg && !(SLACK_PACKAGES as readonly string[]).includes(slackPkg)) {
      throw new Error(
        `workspace "${ws.name}" Slack package "${slackPkg}" is invalid: use one of ${SLACK_PACKAGES.join(", ")}`,
      )
    }
    if (seen.has(ws.name)) throw new Error(`duplicate workspace name "${ws.name}"`)
    seen.add(ws.name)
  }
}

export const labelFromPath = (p: string) =>
  slugify(path.basename(resolveAbsolute(p))) || "workspace"

export const findWorkspace = (cfg: Config, key: string): Workspace | undefined => {
  const byName = cfg.workspaces.find((w) => w.name === key)
  if (byName) return byName
  const target = resolveAbsolute(key)
  return cfg.workspaces.find((w) => resolveAbsolute(w.path) === target)
}

// A directory maps to one workspace (one hook arm, one .mcp.json). This returns
// a workspace already at `target`'s resolved path under a name other than
// `label` (so adding `label` there would duplicate the path), or undefined when
// the path is free or already owned by `label` itself (a normal re-run update).
export const pathConflict = (cfg: Config, target: string, label: string): Workspace | undefined => {
  const abs = resolveAbsolute(target)
  return cfg.workspaces.find((w) => w.name !== label && resolveAbsolute(w.path) === abs)
}

export const upsertWorkspace = (cfg: Config, ws: Workspace): Config => {
  const next = cfg.workspaces.filter((w) => w.name !== ws.name)
  next.push({ ...ws, path: contractTilde(ws.path) })
  next.sort((a, b) => a.name.localeCompare(b.name))
  return { ...cfg, workspaces: next }
}

export const removeWorkspace = (cfg: Config, key: string): { cfg: Config; removed?: Workspace } => {
  const removed = findWorkspace(cfg, key)
  if (!removed) return { cfg }
  return {
    cfg: {
      ...cfg,
      workspaces: cfg.workspaces.filter((w) => w.name !== removed.name),
    },
    removed,
  }
}
