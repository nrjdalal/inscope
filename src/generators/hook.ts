import { claudeConfigDirName, type Config, resolveClaudeWrapper, type Workspace } from "@/config"
import { contractTilde } from "@/env"

const pathPattern = (p: string) => {
  const t = contractTilde(p)
  if (t === "~") return `"$HOME/"*`
  if (t.startsWith("~/")) return `"$HOME/${t.slice(2)}/"*`
  return `"${t}/"*`
}

const slackService = (ws: Workspace) => (ws.servers.slack ? ws.servers.slack.keychain : "")

// Order path arms most-specific-first: a nested workspace must be tested before
// the parent whose path prefix it shares, or the parent's arm shadows it (a
// longer path can only be a prefix of a shorter one, so longest-path-first is
// correct). Stable sort keeps name order on ties, so the output is deterministic.
const bySpecificity = <T extends Workspace>(workspaces: T[]): T[] =>
  [...workspaces].sort((a, b) => contractTilde(b.path).length - contractTilde(a.path).length)

export const HOOK_HEADER = `# Managed by inscope. Do not edit by hand.
# Source of truth: ~/.config/inscope/inscope.json
# Edit there, then run \`inscope apply\` to regenerate this file.
#
# One chpwd hook resolves per-workspace secrets from $PWD on every cd: it maps
# the current directory to a workspace, then pulls that workspace's GitHub token
# from the gh keyring and Slack token from the macOS keychain. Nothing sensitive
# is written to disk, and there is no shared mutable state for sessions to race.`

// The `claude()` launch wrapper. CLAUDE_CONFIG_DIR is a launch-time setting (Claude
// reads it once, at startup, to pick its config dir and login), so a workspace's
// `claude` profile is resolved from $PWD here, in the wrapper, rather than exported
// on every cd. That keeps the token hook above untouched and sets CLAUDE_CONFIG_DIR
// only for the launch it belongs to (no persistent env change). Unmapped dirs keep
// the base ~/.claude.
//
// Emitted when any workspace sets a profile (the wrapper is how that profile is
// delivered) or when `wrapClaude` requests launch flags; otherwise "" (byte-for-byte
// identical hook). The `wrapClaude` update / skip-permissions flags ride on the same
// wrapper. The profile arms are the only user strings, and they are plain slugs
// (validated like a workspace name) interpolated into a quoted path token; the flags
// are fixed literals gated on booleans. Nothing reaches the shell unquoted.
const renderClaudeWrapper = (cfg: Config): string => {
  const wrap = resolveClaudeWrapper(cfg)
  const profiled = bySpecificity(
    cfg.workspaces.filter((w): w is Workspace & { claude: string } => w.claude !== undefined),
  )
  if (!wrap && profiled.length === 0) return ""

  const flags = wrap?.dangerouslySkipPermissions ? " --dangerously-skip-permissions" : ""
  const launch = `command claude${flags} "$@"`
  // With a profile, prefix the launch with the resolved dir (env for that command
  // only). `claude update` refreshes the global CLI, so it runs without the prefix.
  const dirPrefix = profiled.length ? `CLAUDE_CONFIG_DIR="$dir" ` : ""
  const run = wrap?.update
    ? `command claude update && ${dirPrefix}${launch}`
    : `${dirPrefix}${launch}`

  // No profile means the config dir never changes, so skip the resolver and emit
  // the one-line wrapper (a pure `wrapClaude` config).
  if (profiled.length === 0) {
    return `
# Managed by inscope: launch \`claude\` with the flags set in "wrapClaude".
claude() { ${run}; }
`
  }

  const arms = profiled
    .map((w) => `    ${pathPattern(w.path)}) dir="$HOME/${claudeConfigDirName(w.claude)}" ;;`)
    .join("\n")
  return `
# Managed by inscope: pick the Claude config dir for $PWD at launch, so each
# workspace's \`claude\` profile runs on its own login (unmapped dirs keep the
# base). Set "claude" per workspace, and launch flags via "wrapClaude", in
# inscope.json.
claude() {
  local dir="$HOME/${claudeConfigDirName("claude")}"
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
