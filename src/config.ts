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

export const slackKeychainFor = (label: string): string =>
  `SLACK_MCP_XOXP_TOKEN_${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`

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
  xquik?: boolean | HttpServer
}

export type Workspace = {
  // Give this workspace its own Claude Code login: apply scaffolds a
  // workspace-local config dir at `<path>/.inscope`, and the chpwd hook exports
  // CLAUDE_CONFIG_DIR to point there whenever $PWD is under this subtree (so any
  // launcher that inherits the shell env, a terminal, cmux, an IDE, uses that
  // login). Omit to run on the shared ~/.claude like every unmapped directory.
  // Kept first so an isolated workspace is flagged at the top of its block.
  isolate?: boolean
  name: string
  path: string
  gh?: string
  git?: { email?: string; name?: string }
  servers: Servers
  // Skills this workspace makes available to Claude. Materialized on apply as
  // symlinks into the workspace's personal Claude skills dir, pointing at a shared
  // local cache (see SkillSpec and generators/skills.ts). An isolated workspace keeps
  // its skills private in `<path>/.inscope/skills`; a non-isolated one shares
  // `~/.claude/skills` with every other non-isolated workspace.
  skills?: SkillSpec[]
  // The bundled inscope self-skill (which teaches Claude how to drive inscope) is
  // linked into every workspace by default. Set false to opt this workspace out;
  // `inscope skill rm inscope` writes that, `inscope skill add inscope` clears it.
  selfSkill?: boolean
}

// A skill declared on a workspace. Either a string shorthand `"<source>#<subdir>"`
// (e.g. `"owner/repo#skills/readme-audit"`) or the object form. See normalizeSkill
// for how both collapse to a NormalizedSkill. `ref` is git-only and pins a branch,
// tag, or sha; omitted, it floats on the source's default branch.
export type SkillSpec = string | { name?: string; source: string; path?: string; ref?: string }

// A skill source, after classifying the `source` string: a GitHub `owner/repo`, a
// full git URL, or a local path. Only the git kinds carry a ref.
export type SkillSource =
  | { kind: "github"; repo: string }
  | { kind: "git"; url: string }
  | { kind: "local"; path: string }

export type NormalizedSkill = {
  // The directory/command name under `.claude/skills/`; becomes `/name` in Claude.
  name: string
  source: SkillSource
  // git only; floats on the default branch when omitted.
  ref?: string
  // Path within the source that holds `SKILL.md`, when the skill is not at the root.
  subdir?: string
}

export type Config = {
  version: number
  // Bypass Claude's permission prompts in each ISOLATED workspace's own login, by
  // writing `permissions.defaultMode: "bypassPermissions"` plus the pre-seeded
  // bypass dialog acceptance into its `<path>/.inscope/settings.json`
  // (launcher-agnostic: any launcher that runs on that login honors it, and a
  // fresh login skips the one-time warning dialog). Without it, Claude Code
  // v2.1.228+ starts sessions in its own auto-mode default. The shared ~/.claude
  // base login is yours to manage; inscope never writes there. Dangerous, so it
  // is opt-in and never implied.
  bypass?: boolean
  workspaces: Workspace[]
}

export const CONFIG_VERSION = 1

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
  // edit, remove, diff --adopt) is guarded by construction, not by each
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

// A skill name is a single directory name under `.claude/skills/` (and a
// `.gitignore` path segment), so it must be a plain slug with no separators or
// `.`/`..` traversal. It is never interpolated into the zsh hook.
export const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/

export const skillNameError = (name: string): string | null => {
  if (!name) return "must not be empty"
  if (name === "." || name === "..") return "must not be . or .."
  if (!SKILL_NAME_RE.test(name))
    return "use only letters, digits, dot (.), dash (-), or underscore (_)"
  return null
}

// "inscope" names the bundled self-skill, so a workspace skill may not take it.
export const RESERVED_SKILL_NAME = "inscope"

// A skill subdir locates `SKILL.md` inside a cloned/local source, so it must be a
// relative path with no `..` escape and no newline. Forward and back slashes are
// both treated as separators when checking for traversal.
export const skillSubdirError = (sub: string): string | null => {
  if (!sub) return "must not be empty"
  if (sub.startsWith("/")) return "must be a relative path (no leading /)"
  if (/[\n\r]/.test(sub)) return "must not contain a newline"
  if (sub.split(/[\\/]/).some((seg) => seg === "..")) return "must not contain .."
  return null
}

const GITHUB_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const isLocalSource = (s: string) => s.startsWith("~") || s.startsWith(".") || s.startsWith("/")
const isGitUrl = (s: string) =>
  /^(https?|ssh|git):\/\//.test(s) || s.startsWith("git@") || s.endsWith(".git")

// Classify a `source` string into a github/git/local source. A leading `~`, `.`,
// or `/` marks a local path; a scheme (or a `.git` suffix, or `git@`) marks a git
// URL; a bare `owner/repo` is GitHub. Anything else is ambiguous and rejected.
const GITHUB_URL_RE =
  /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/

export const classifySkillSource = (s: string): SkillSource => {
  // A leading "-" would be parsed as an option by the `git clone` inscope shells
  // out to; reject it up front (no legitimate source starts with a dash).
  if (s.startsWith("-")) throw new Error(`skill source "${s}" must not start with "-"`)
  // git's `transport::address` remote-helper syntax (e.g. `ext::`, `fd::`) runs an
  // external helper program at clone time, and a `.git` suffix would otherwise let
  // it slip through isGitUrl below. No legitimate skill source uses it.
  if (/^[A-Za-z][\w+.-]*::/.test(s))
    throw new Error(`skill source "${s}" must not use a git remote-helper transport (e.g. "ext::")`)
  if (isLocalSource(s)) return { kind: "local", path: s }
  // Normalize a github.com URL and an `owner/repo(.git)` to the github kind, so the
  // same repo caches once regardless of how it was written (URL vs shorthand).
  const url = s.match(GITHUB_URL_RE)
  if (url) return { kind: "github", repo: `${url[1]}/${url[2]}` }
  const bare = s.replace(/\.git$/, "")
  if (GITHUB_SLUG_RE.test(bare)) return { kind: "github", repo: bare }
  if (isGitUrl(s)) return { kind: "git", url: s }
  throw new Error(
    `skill source "${s}" is not a github owner/repo, a git URL, or a local path (~/… ./… /…)`,
  )
}

// A relative local source (`./x`, `../x`) resolved to a stable, cwd-independent
// path at add time, so a later apply from a different cwd still finds it. Absolute
// and `~`-anchored sources, and non-local ones (github/git), pass through unchanged.
export const absolutizeLocalSource = (source: string): string =>
  source.startsWith(".") ? contractTilde(resolveAbsolute(source)) : source

const stripDotGit = (s: string) => s.replace(/\.git$/, "")

const defaultSkillName = (source: SkillSource, subdir?: string): string => {
  if (subdir) return path.basename(subdir)
  if (source.kind === "github") return path.basename(source.repo)
  if (source.kind === "git") return path.basename(stripDotGit(source.url))
  return path.basename(resolveAbsolute(source.path))
}

// Collapse a SkillSpec (string shorthand or object) into a NormalizedSkill. The
// string form splits on the first `#` into `<source>#<subdir>`; the object form
// takes `source`/`path`/`ref`/`name` directly. A missing `name` defaults to the
// subdir's (or source's) basename. Throws on an unclassifiable source.
export const normalizeSkill = (spec: SkillSpec): NormalizedSkill => {
  let sourceStr: string
  let subdir: string | undefined
  let ref: string | undefined
  let explicitName: string | undefined
  if (typeof spec === "string") {
    const hash = spec.indexOf("#")
    sourceStr = hash >= 0 ? spec.slice(0, hash) : spec
    subdir = hash >= 0 ? spec.slice(hash + 1) : undefined
  } else {
    sourceStr = spec.source
    subdir = spec.path
    ref = spec.ref
    explicitName = spec.name
  }
  const source = classifySkillSource(sourceStr)
  // Validate ref here (not only at persist time) so a CLI `--ref` is checked
  // before `skill add` resolves/clones it: ref reaches `git checkout`/`--branch`,
  // so reject a leading "-" (option injection) and a newline, like the source.
  if (ref && (ref.startsWith("-") || /[\n\r]/.test(ref)))
    throw new Error(`skill ref "${ref}" must not start with "-" or contain a newline`)
  return {
    name: explicitName || defaultSkillName(source, subdir),
    source,
    ref: ref || undefined,
    subdir: subdir || undefined,
  }
}

// Rename a skill spec to `name`, returning the object form (a name lives only there),
// preserving source/subdir/ref. A string shorthand `source#subdir` is expanded; an
// object spec just takes the new name. Used by `inscope skill rename`.
export const renameSkillSpec = (spec: SkillSpec, name: string): SkillSpec => {
  if (typeof spec !== "string") return { ...spec, name }
  const hash = spec.indexOf("#")
  const source = hash >= 0 ? spec.slice(0, hash) : spec
  const subdir = hash >= 0 ? spec.slice(hash + 1) : undefined
  return { name, source, ...(subdir ? { path: subdir } : {}) }
}

// The workspace whose path most specifically contains `cwd`, mirroring the hook's
// most-specific-first `$PWD` match: a nested workspace wins over the parent whose
// path it sits under, ties broken by longer path then name for determinism. Used
// by doctor and by `inscope skill` to infer the workspace from where you run it.
export const currentWorkspace = (
  cfg: Config,
  cwd: string = process.cwd(),
): Workspace | undefined => {
  const abs = resolveAbsolute(cwd)
  let best: Workspace | undefined
  let bestLen = -1
  for (const w of cfg.workspaces) {
    const root = resolveAbsolute(w.path)
    if ((abs === root || abs.startsWith(root + path.sep)) && root.length > bestLen) {
      best = w
      bestLen = root.length
    }
  }
  return best
}

export const validateConfig = (cfg: Config) => {
  if (!cfg || typeof cfg !== "object") throw new Error("config is not an object")
  const versionErr = configVersionError(cfg)
  if (versionErr) throw new Error(versionErr)
  if (!Array.isArray(cfg.workspaces)) throw new Error("config.workspaces must be an array")
  if (cfg.bypass !== undefined && typeof cfg.bypass !== "boolean")
    throw new Error("config bypass must be a boolean")
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
    if (ws.selfSkill !== undefined && typeof ws.selfSkill !== "boolean")
      throw new Error(`workspace "${ws.name}" selfSkill must be a boolean`)
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
    if (ws.skills !== undefined) {
      if (!Array.isArray(ws.skills))
        throw new Error(`workspace "${ws.name}" skills must be an array`)
      const seenSkill = new Set<string>()
      for (const spec of ws.skills) {
        const isStr = typeof spec === "string"
        if (!isStr && (spec === null || typeof spec !== "object" || Array.isArray(spec)))
          throw new Error(`workspace "${ws.name}" has a skill that is not a string or object`)
        if (!isStr) {
          const o = spec as Record<string, unknown>
          if (typeof o.source !== "string" || !o.source)
            throw new Error(`workspace "${ws.name}" has a skill missing a "source"`)
          for (const k of ["name", "path", "ref"]) {
            if (o[k] !== undefined && typeof o[k] !== "string")
              throw new Error(`workspace "${ws.name}" skill ${k} must be a string`)
          }
        }
        let norm: NormalizedSkill
        try {
          norm = normalizeSkill(spec)
        } catch (err) {
          throw new Error(`workspace "${ws.name}" ${err instanceof Error ? err.message : err}`)
        }
        const nameErr = skillNameError(norm.name)
        if (nameErr)
          throw new Error(`workspace "${ws.name}" skill name "${norm.name}" is invalid: ${nameErr}`)
        if (norm.name === RESERVED_SKILL_NAME)
          throw new Error(
            `workspace "${ws.name}" skill name "${norm.name}" is reserved for the bundled self-skill`,
          )
        if (norm.subdir) {
          const subErr = skillSubdirError(norm.subdir)
          if (subErr)
            throw new Error(
              `workspace "${ws.name}" skill path "${norm.subdir}" is invalid: ${subErr}`,
            )
        }
        // ref is validated inside normalizeSkill above (throws), so no check here.
        if (seenSkill.has(norm.name))
          throw new Error(`workspace "${ws.name}" has duplicate skill name "${norm.name}"`)
        seenSkill.add(norm.name)
      }
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
  // Store a stable, cwd-independent path: resolve a relative input (`.`, `./x`,
  // `myproj`) to absolute before contracting. Left cwd-relative, it is later
  // re-resolved against whatever cwd apply/the hook runs from, pointing the hook
  // arm, .mcp.json, and git include at the wrong directory.
  next.push({ ...ws, path: contractTilde(resolveAbsolute(ws.path)) })
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
