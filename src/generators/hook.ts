import type { Config, Workspace } from "@/config"
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
# from the gh keyring and Slack tokens from the macOS keychain. Nothing sensitive
# is written to disk, and there is no shared mutable state for sessions to race.`

// True when `child` is strictly nested under `parent`, compared as ~-normalized
// path tokens so it is deterministic and independent of the real home dir.
const nestedUnder = (child: string, parent: string): boolean => {
  const p = contractTilde(parent)
  return contractTilde(child).startsWith(p.endsWith("/") ? p : `${p}/`)
}

// The per-location Claude login, resolved from $PWD on every cd and EXPORTED, so
// any launcher that inherits this shell (a terminal, cmux, an IDE, `--resume`) runs
// on it, not just a `claude` typed here. An isolated workspace points
// CLAUDE_CONFIG_DIR at its local `<path>/.inscope`; every other directory keeps your
// base login (the CLAUDE_CONFIG_DIR this shell had before inscope set it, else
// ~/.claude). Returns the in-hook pieces: `block` splices into
// __inscope_resolve_identity, `base` captures the login to fall back to when the hook
// is sourced. Arms interpolate validated, double-quoted paths. (Skills need no arm
// here: they live in each login's personal skills dir, so Claude loads them directly.)
//
// The base must never be one of inscope's own isolated logins. Re-sourcing the hook
// (`source ~/.zshrc`, `exec zsh`) or starting a child shell (a tmux/cmux/IDE pane)
// inside an isolated workspace inherits CLAUDE_CONFIG_DIR=<ws>/.inscope; adopting that
// as the base would carry the isolated login into every other directory. So inscope
// exports the value it set as INSCOPE_CCD and the true base as INSCOPE_BASE_CCD: a
// CLAUDE_CONFIG_DIR equal to INSCOPE_CCD is inscope's own (keep the inherited base),
// any other value is the user's own (it becomes the base), and an isolated
// `*/.inscope` value is never a base.
const baseCapture = `if [[ -z "\${INSCOPE_CCD+x}" || "\${CLAUDE_CONFIG_DIR-}" != "$INSCOPE_CCD" ]]; then
  case "\${CLAUDE_CONFIG_DIR-}" in
    */.inscope|*/.inscope/) export INSCOPE_BASE_CCD="\${INSCOPE_BASE_CCD-}" ;;   # an isolated login is never the base
    *) export INSCOPE_BASE_CCD="\${CLAUDE_CONFIG_DIR-}" ;;                        # your own value (empty -> ~/.claude)
  esac
fi
`

// With no workspace isolated the hook never sets CLAUDE_CONFIG_DIR, but a shell can
// still inherit inscope's own export (or an isolated login) from one that had
// isolation, or from an older config. Restore the base it came from, so no
// directory runs on that login.
const dropInherited = `if [[ ( -n "\${INSCOPE_CCD+x}" && "\${CLAUDE_CONFIG_DIR-}" == "$INSCOPE_CCD" ) || "\${CLAUDE_CONFIG_DIR-}" == */.inscope || "\${CLAUDE_CONFIG_DIR-}" == */.inscope/ ]]; then
  # inherited from a shell that had an isolated workspace; none is isolated now
  if [[ -n "\${INSCOPE_BASE_CCD-}" ]]; then export CLAUDE_CONFIG_DIR="$INSCOPE_BASE_CCD"; else unset CLAUDE_CONFIG_DIR; fi
fi
unset INSCOPE_CCD INSCOPE_BASE_CCD   # no isolated workspace: nothing to fall back from
`

const renderCcd = (cfg: Config): { block: string; base: string } => {
  const isolated = cfg.workspaces.filter((w) => w.isolate)
  if (isolated.length === 0) return { block: "", base: dropInherited }

  // A workspace nested under an isolated one gets its own arm so it reflects its own
  // login rather than inheriting the parent's broad `"<parent>/"*` arm; a
  // non-isolated nested one gets a no-op shadow arm so it keeps the base login.
  // Name-sort then most-specific-first, matching the resolver's order.
  const shadows = cfg.workspaces.filter(
    (w) => !w.isolate && isolated.some((a) => a.name !== w.name && nestedUnder(w.path, a.path)),
  )
  const byName = [...isolated, ...shadows].sort((a, b) => a.name.localeCompare(b.name))
  const arms = bySpecificity(byName)
    .map(
      (w) =>
        `    ${pathPattern(w.path)}) ${w.isolate ? `dir="${shellPath(w.path)}/.inscope"` : ":"} ;;`,
    )
    .join("\n")

  const block = `
  # Pin the Claude login for this location and export it, so any launcher that
  # inherits this shell (a terminal, cmux, an IDE) runs on it, not just a typed
  # \`claude\`. An isolated workspace uses its local .inscope login; every other
  # directory keeps your base login (INSCOPE_BASE_CCD, else ~/.claude). INSCOPE_CCD
  # records what inscope set, so a re-source or child shell can tell it apart.
  local dir="\${INSCOPE_BASE_CCD:-$HOME/.claude}"
  case "\${PWD}/" in
${arms}
  esac
  export CLAUDE_CONFIG_DIR="$dir" INSCOPE_CCD="$dir"
`
  return { block, base: baseCapture }
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

  const { block: ccdBlock, base: ccdBase } = renderCcd(cfg)

  return `${HOOK_HEADER}
__inscope_resolve_identity() {
  local ws
  case "\${PWD}/" in
${dirArms}
    *) ws="" ;;
  esac
  [[ "$ws" == "$__inscope_ws" ]] && return            # workspace unchanged, skip the lookups
  __inscope_ws="$ws"
${ccdBlock}  unset GITHUB_TOKEN GH_TOKEN SLACK_MCP_XOXP_TOKEN   # clear previous (and any inherited) tokens

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
${ccdBase}__inscope_ws="__init__"          # force the first resolve, clearing any inherited token
__inscope_resolve_identity
`
}
