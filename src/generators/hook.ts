import { type Config, resolveClaudeLaunch, type Workspace } from "@/config"
import { contractTilde } from "@/env"

const pathPattern = (p: string) => {
  const t = contractTilde(p)
  if (t === "~") return `"$HOME/"*`
  if (t.startsWith("~/")) return `"$HOME/${t.slice(2)}/"*`
  return `"${t}/"*`
}

// A workspace path as a shell path token: `~` -> `$HOME`, `~/x` -> `$HOME/x`, and
// a non-home absolute path verbatim. Double-quoted at the use site, so spaces are
// safe. Used to point CLAUDE_CONFIG_DIR at the workspace-local `<path>/.inscope`.
const shellPath = (p: string) => {
  const t = contractTilde(p)
  if (t === "~") return `$HOME`
  if (t.startsWith("~/")) return `$HOME/${t.slice(2)}`
  return t
}

// Order path arms most-specific-first: a nested workspace must be tested before
// the parent whose path prefix it shares, or the parent's arm shadows it (a
// longer path can only be a prefix of a shorter one, so longest-path-first is
// correct). Stable sort keeps name order on ties, so the output is deterministic.
const bySpecificity = <T extends Workspace>(workspaces: T[]): T[] =>
  [...workspaces].sort((a, b) => contractTilde(b.path).length - contractTilde(a.path).length)

const slackService = (ws: Workspace) => (ws.servers.slack ? ws.servers.slack.keychain : "")

export const HOOK_HEADER = `# Managed by inscope. Do not edit by hand.
# Source of truth: ~/.config/inscope/inscope.json
# Edit there, then run \`inscope apply\` to regenerate this file.
#
# One chpwd hook resolves per-workspace secrets from $PWD on every cd: it maps
# the current directory to a workspace, then pulls that workspace's GitHub token
# from the gh keyring and Slack token from the macOS keychain. Nothing sensitive
# is written to disk, and there is no shared mutable state for sessions to race.`

// True when `child` is strictly nested under `parent`, compared as ~-normalized
// path tokens so it is deterministic and independent of the real home dir.
const nestedUnder = (child: string, parent: string): boolean => {
  const p = contractTilde(parent)
  return contractTilde(child).startsWith(p.endsWith("/") ? p : `${p}/`)
}

// The opt-in `claude()` launch wrapper for isolated workspaces. CLAUDE_CONFIG_DIR is
// a launch-time setting (Claude reads it once, at startup, to pick its config dir and
// login), so an isolated workspace's dir is resolved here, from $PWD, at the moment you
// launch, and set only for that `claude` (no persistent env change, and the token hook
// above stays untouched). An isolated workspace uses its workspace-local `<path>/.inscope`;
// every other directory keeps your normal login: an inherited CLAUDE_CONFIG_DIR if you
// export one, else ~/.claude. Emitted only when at least one workspace is isolated, so
// configs without `isolate` render a byte-for-byte identical hook. The arms interpolate
// workspace paths (validated, double-quoted); nothing else reaches the shell.
const renderClaudeWrapper = (cfg: Config): string => {
  const launch = resolveClaudeLaunch(cfg)
  const hasFlags = !!launch && (launch.update || launch.dangerouslySkipPermissions)
  const isolated = cfg.workspaces.filter((w) => w.isolate)
  // Nothing to wrap: no isolated login to route and no launch flags requested.
  if (isolated.length === 0 && !hasFlags) return ""

  // Launch flags ride on the same wrapper. `--dangerously-skip-permissions` is
  // appended to the launch; `claude update` refreshes the global CLI, so it runs
  // first and without the per-launch CLAUDE_CONFIG_DIR prefix. It is best-effort
  // (`;`, not `&&`), so a failed/offline update never blocks the launch. Both are
  // fixed literals gated on booleans, so nothing user-controlled reaches the shell.
  const flags = launch?.dangerouslySkipPermissions ? " --dangerously-skip-permissions" : ""
  const dirPrefix = isolated.length ? `CLAUDE_CONFIG_DIR="$dir" ` : ""
  const bare = `${dirPrefix}command claude${flags} "$@"`
  const run = launch?.update ? `command claude update; ${bare}` : bare

  // Flags-only config (nothing isolated): the config dir never changes, so skip
  // the resolver and emit a one-line wrapper.
  if (isolated.length === 0) {
    return `
# Managed by inscope: launch \`claude\` with the flags set in the top-level "claude".
claude() { ${run}; }
`
  }

  // A non-isolated workspace nested under an isolated one needs a shadow arm, or
  // the parent's broad `"<parent>/"*` arm would capture it and hand the child the
  // parent's login despite it opting out. The token resolver above already maps
  // the child to its own workspace; mirror that here by matching the child first
  // and leaving `dir` at the default. Only nested opt-outs need an arm.
  const shadows = cfg.workspaces.filter(
    (w) => !w.isolate && isolated.some((iso) => nestedUnder(w.path, iso.path)),
  )
  // Name-sort the base so ties (equal-length paths) order the same as the token
  // resolver, which builds its arms from a name-sorted list; bySpecificity then
  // puts the most specific first.
  const byName = [...isolated, ...shadows].sort((a, b) => a.name.localeCompare(b.name))
  const arms = bySpecificity(byName)
    .map((w) =>
      w.isolate
        ? `    ${pathPattern(w.path)}) dir="${shellPath(w.path)}/.inscope" ;;`
        : `    ${pathPattern(w.path)}) : ;;`,
    )
    .join("\n")
  return `
# Managed by inscope: launch \`claude\` on an isolated workspace's own login. The
# config dir is resolved from $PWD here (not exported on every cd) and set only for
# this launch; isolated workspaces use their local .inscope, everything else keeps
# your normal login (an inherited CLAUDE_CONFIG_DIR, else ~/.claude). Launch flags
# come from the top-level "claude"; toggle "isolate" per workspace in inscope.json.
claude() {
  local dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  case "\${PWD}/" in
${arms}
  esac
  ${run}
}
`
}

export const renderHook = (cfg: Config): string => {
  const byName = [...cfg.workspaces].sort((a, b) => a.name.localeCompare(b.name))

  const dirArms =
    bySpecificity(byName)
      .map((w) => `    ${pathPattern(w.path)}) ws="${w.name}" ;;`)
      .join("\n") || "    # no workspaces configured"

  // The id arms key on the exact `$ws` value, so their order is cosmetic; keep
  // them name-sorted for a stable, readable artifact.
  const idArms =
    byName
      .map((w) => {
        const parts: string[] = []
        if (w.gh) parts.push(`gh_user="${w.gh}"`)
        const svc = slackService(w)
        if (svc) parts.push(`slack_svc="${svc}"`)
        return `    ${w.name}) ${parts.length ? parts.join("; ") : ":"} ;;`
      })
      .join("\n") || "    # no workspaces configured"

  return `${HOOK_HEADER}
__inscope_resolve_identity() {
  local ws
  case "\${PWD}/" in
${dirArms}
    *) ws="" ;;
  esac
  [[ "$ws" == "$__inscope_ws" ]] && return            # workspace unchanged, skip the lookups
  __inscope_ws="$ws"
  unset GITHUB_TOKEN GH_TOKEN SLACK_MCP_XOXP_TOKEN   # clear previous (and any inherited) tokens

  local gh_user="" slack_svc=""
  case "$ws" in
${idArms}
    *) return ;;                                     # outside a mapped workspace: nothing set
  esac

  local tok
  if [[ -n "$gh_user" ]]; then
    if tok="$(gh auth token -u "$gh_user" 2>/dev/null)" && [[ -n "$tok" ]]; then
      export GITHUB_TOKEN="$tok" GH_TOKEN="$tok"
    else
      print -u2 "inscope: no gh token for $gh_user; GITHUB_TOKEN/GH_TOKEN unset"
    fi
  fi
  if [[ -n "$slack_svc" ]]; then
    if tok="$(security find-generic-password -a "$USER" -s "$slack_svc" -w 2>/dev/null)" && [[ -n "$tok" ]]; then
      export SLACK_MCP_XOXP_TOKEN="$tok"
    else
      print -u2 "inscope: $slack_svc not in keychain; SLACK_MCP_XOXP_TOKEN unset"
    fi
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd __inscope_resolve_identity
__inscope_ws="__init__"          # force the first resolve, clearing any inherited token
__inscope_resolve_identity
${renderClaudeWrapper(cfg)}`
}
