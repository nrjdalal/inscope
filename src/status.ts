import { type Config, currentWorkspace } from "@/config"
import { contractTilde } from "@/env"
import { baseClaudeDir, inscopeDirPath } from "@/generators/isolate"
import { SERVER_TYPES } from "@/generators/mcp"
import { desiredSkillLinks } from "@/generators/skills"
import { claudeAuthStatus, defaultRunner, ghToken, gitGlobal, type Runner } from "@/secrets"

// The identity `inscope status` resolves for one directory: the Claude login it
// would run on, the GitHub account, the git commit email, MCP servers, and
// skills. A plain data object so the render is pure (golden-pinned) and the
// resolve (which shells out to claude/gh/git) is the only side-effecting part.
export type StatusClaude = {
  isolated: boolean
  configDir: string
  signedIn: boolean
  email?: string
  subscription?: string
  org?: string
}

export type StatusSnapshot = {
  workspace: string | null
  path: string
  claude: StatusClaude
  github: { account: string; token: boolean } | null
  git: { email: string | null; source: "workspace" | "global" }
  servers: string[]
  skills: string[]
}

export const resolveStatus = (
  cfg: Config,
  { cwd = process.cwd(), run = defaultRunner }: { cwd?: string; run?: Runner } = {},
): StatusSnapshot => {
  const ws = currentWorkspace(cfg, cwd)
  const isolated = Boolean(ws?.isolate)
  const configDir = isolated && ws ? inscopeDirPath(ws) : baseClaudeDir()
  const auth = claudeAuthStatus(configDir, run)
  return {
    workspace: ws?.name ?? null,
    path: ws ? ws.path : contractTilde(cwd),
    claude: {
      isolated,
      configDir: contractTilde(configDir),
      signedIn: auth.signedIn,
      email: auth.email,
      subscription: auth.subscriptionType,
      org: auth.orgName,
    },
    github: ws?.gh ? { account: ws.gh, token: Boolean(ghToken(ws.gh, run)) } : null,
    git: ws?.git?.email
      ? { email: ws.git.email, source: "workspace" }
      : { email: gitGlobal("user.email", run), source: "global" },
    servers: ws
      ? SERVER_TYPES.filter((t) => Boolean((ws.servers as Record<string, unknown>)[t]))
      : [],
    skills: ws ? desiredSkillLinks(ws).map((d) => d.name) : [],
  }
}

type Paint = (s: string) => string
export type StatusPainters = { head: Paint; ok: Paint; warn: Paint; dim: Paint }
const PLAIN: StatusPainters = { head: (s) => s, ok: (s) => s, warn: (s) => s, dim: (s) => s }

const LABEL_W = 6
// Continuation lines (e.g. the Claude config dir) align under the value column:
// 2 indent + label width + 2 gap.
const CONT = " ".repeat(2 + LABEL_W + 2)
const row = (label: string, value: string) => `  ${label.padEnd(LABEL_W)}  ${value}`

// Pure: same snapshot in, same lines out (pinned by the golden suite). Painters
// default to no-ops, so the golden output is plain; the command passes the real
// palette, which itself no-ops when stdout is piped.
export const renderStatus = (snap: StatusSnapshot, c: StatusPainters = PLAIN): string => {
  const lines: string[] = []
  lines.push(`  ${c.head(snap.workspace ?? "no workspace")}  ${c.dim(snap.path)}`)
  lines.push("")

  const scope = snap.claude.isolated ? "isolated" : "shared"
  const who =
    snap.claude.signedIn && snap.claude.email
      ? `${snap.claude.email}${snap.claude.subscription ? ` · ${snap.claude.subscription}` : ""}`
      : c.warn("not signed in; launch `claude` here and log in")
  lines.push(row("Claude", `${scope} · ${who}`))
  lines.push(`${CONT}${c.dim(snap.claude.configDir)}`)

  if (snap.workspace)
    lines.push(row("MCP", snap.servers.length ? snap.servers.join(", ") : c.dim("none")))

  if (snap.github) {
    const tok = snap.github.token ? c.ok("token ok") : c.warn("no token; run `gh auth login`")
    lines.push(row("GitHub", `${snap.github.account} · ${tok}`))
  }

  lines.push(row("Git", `${snap.git.email ?? c.dim("(unset)")} ${c.dim(`(${snap.git.source})`)}`))

  if (snap.workspace && snap.skills.length) lines.push(row("Skills", snap.skills.join(", ")))

  return lines.join("\n")
}
