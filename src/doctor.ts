import fs from "node:fs"
import path from "node:path"

import { zshrcSourcesHook } from "@/apply"
import { type Config, normalizeSkill, POOL_NAME_RE, type Workspace } from "@/config"
import { mcpError, mcpTarget } from "@/drift"
import { contractTilde, gitconfigPath, hookPath, resolveAbsolute } from "@/env"
import {
  GITCONFIG_BLOCK_ID,
  hasGitIdentity,
  perWorkspaceGitconfigPath,
} from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { baseClaudeDir, INSCOPE_DIR, inscopeDirPath, inscopeSignedIn } from "@/generators/isolate"
import { managedKeys, mcpFilePath, readMcp, slackPackageSpec } from "@/generators/mcp"
import {
  hasBypassAcceptance,
  hasBypassSetting,
  loginDefaultMode,
  routedAt,
  staleRoutingAt,
} from "@/generators/settings"
import {
  desiredSkillLinks,
  foreignSkillAt,
  sharedNameClash,
  skillLinkTarget,
} from "@/generators/skills"
import { readFileOrNull } from "@/io"
import { assertBlockWellFormed, readBlock } from "@/managed-block"
import {
  PROXY_KEYCHAIN,
  PROXY_VERSION,
  proxyAccounts,
  proxyAuthDir,
  proxyBinPath,
  proxyConfigPath,
  poolFlag,
  poolHasKey,
  proxyLabel,
  proxyLoaded,
  readProxyKey,
  proxyRoot,
  launchAgentPath,
  poolDir,
  configPools,
  DEFAULT_POOL,
  routeFor,
  proxyUrl,
} from "@/proxy"
import {
  defaultRunner,
  ghToken,
  gitEmailForFile,
  isMacOS,
  keychainHas,
  keychainHasService,
  keychainSetCommand,
  type Runner,
} from "@/secrets"

export type CheckStatus = "ok" | "warn" | "fail"
export type Check = { status: CheckStatus; label: string; detail?: string }

// The @nrjdalal Slack fork is rendered on @latest on purpose, so it is not an
// accidental unpin; doctor skips it rather than nagging about it every run.
const INTENTIONALLY_FLOATING = slackPackageSpec("@nrjdalal/slack-mcp-server")

const unpinnedServers = (doc: Record<string, any> | null): string[] => {
  const out: string[] = []
  const servers = doc?.mcpServers
  if (!servers || typeof servers !== "object") return out
  for (const [name, def] of Object.entries<any>(servers)) {
    const args: string[] = Array.isArray(def?.args) ? def.args : []
    if (args.includes(INTENTIONALLY_FLOATING)) {
      continue
    } else if (args.some((a) => typeof a === "string" && a.endsWith("@latest"))) {
      out.push(name)
    } else if (def?.command === "npx") {
      const pkg = args.find((a) => typeof a === "string" && !a.startsWith("-"))
      if (pkg && !pkg.includes("@")) out.push(name)
    }
  }
  return out
}

// Lives in config.ts now (shared with `inscope skill`); re-exported here so the
// doctor command and existing tests keep importing it from @/doctor.
export { currentWorkspace } from "@/config"

// Org-managed Claude Code settings on macOS. When they set
// `permissions.disableBypassPermissionsMode: "disable"`, Claude ignores a
// `bypassPermissions` defaultMode from every other settings file, so inscope's
// bypass would be silently inert; doctor surfaces that instead.
export const MANAGED_SETTINGS_PATH = "/Library/Application Support/ClaudeCode/managed-settings.json"

export const bypassDisabledByPolicy = (file: string = MANAGED_SETTINGS_PATH): boolean => {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"))
    return doc?.permissions?.disableBypassPermissionsMode === "disable"
  } catch {
    // Missing or unreadable managed settings mean no policy; a malformed file is
    // Claude's to complain about, not doctor's.
    return false
  }
}

export const liveSnapshot = (run: Runner = defaultRunner) => {
  const gh = run("gh", ["api", "user", "--jq", ".login"])
  const email = run("git", ["config", "user.email"])
  return {
    pwd: process.cwd(),
    gh: gh.status === 0 && gh.stdout.trim() ? gh.stdout.trim() : "none",
    gitEmail: email.status === 0 ? email.stdout.trim() : "none",
    tokenSet: Boolean(process.env.GITHUB_TOKEN),
  }
}

// Bypass drift on a login inscope owns (an isolated `.inscope`),
// both directions: configured but not applied, and the dangerous reverse, turned off
// in config but the login still auto-approves on disk. A login written by an older
// inscope has the mode without the dialog acceptance, so Claude still shows the
// one-time bypass dialog and refuses background sessions there; a re-run of apply
// seeds it. Claude Code (v2.1.283+ makes auto the built-in default) offers once to
// switch a login's defaultMode to auto, and accepting rewrites it in place, so that
// case gets its own hint.
const bypassChecks = (tag: string, ws: Workspace, bypass: boolean): Check[] => {
  const out: Check[] = []
  if (bypass && loginDefaultMode(ws) === "auto")
    out.push({
      status: "warn",
      label: tag,
      detail:
        "bypass configured but this login was switched to auto mode (Claude's one-time auto-mode offer); run `inscope apply` and decline the offer",
    })
  else if (bypass && !hasBypassSetting(ws))
    out.push({
      status: "warn",
      label: tag,
      detail: "bypass configured but not applied to this login; run `inscope apply`",
    })
  else if (!bypass && hasBypassSetting(ws))
    out.push({
      status: "warn",
      label: tag,
      detail: "bypass is off in config but this login still has it; run `inscope apply`",
    })
  else if (bypass && !hasBypassAcceptance(ws))
    out.push({
      status: "warn",
      label: tag,
      detail: "bypass applied without the dialog acceptance seeded; run `inscope apply`",
    })
  return out
}

// A login's routing matches the config, both directions: the proxy is configured but
// this login does not go through it yet, or the proxy was removed and the login still
// points at it (where nothing answers). Null when it matches.
const routingDrift = (dir: string, cfg: Config, ws?: Workspace): string | null => {
  const route = routeFor(cfg, ws)
  if (route && !routedAt(dir, route))
    return `does not go through ${ws?.pool ? `pool ${ws.pool}` : "the proxy"} yet; run \`inscope apply\``
  if (!route && staleRoutingAt(dir))
    return "still points at the proxy, which is no longer set up; run `inscope apply`"
  return null
}

// The local proxy (`inscope login`), once per pool: installed at the pinned version, its
// client key in the Keychain, its config and token dir private, its launchd agent loaded
// and listening on the pool's port, and at least one account signed in.
const proxyChecks = (cfg: Config, run: Runner): Check[] => {
  const out: Check[] = []
  const pools = configPools(cfg)
  if (!pools.length) return out
  const fix = "run `inscope proxy setup`"
  if (!fs.existsSync(proxyBinPath()))
    out.push({
      status: "fail",
      label: "proxy",
      detail: `CLIProxyAPI ${PROXY_VERSION} is not installed; ${fix}`,
    })
  if (!keychainHasService(PROXY_KEYCHAIN, run))
    out.push({
      status: "fail",
      label: "proxy",
      detail: `${PROXY_KEYCHAIN} not in keychain; ${fix}`,
    })
  // A pool the config no longer names (a hand-edited config, or a sign-in cut short):
  // its launchd agent may still keep a proxy running, holding accounts no login reaches.
  const known = new Set(pools.map((p) => p.name))
  const strays = new Set<string>()
  try {
    for (const d of fs.readdirSync(path.join(proxyRoot(), "pools"), { withFileTypes: true }))
      if (d.isDirectory() && !known.has(d.name)) strays.add(d.name)
  } catch {}
  try {
    const prefix = `${proxyLabel(DEFAULT_POOL)}.`
    for (const f of fs.readdirSync(path.dirname(launchAgentPath())))
      if (f.startsWith(prefix) && f.endsWith(".plist")) {
        // the default pool's own dev.inscope.proxy.plist also matches the prefix
        const name = f.slice(prefix.length, -".plist".length)
        if (name && !known.has(name)) strays.add(name)
      }
  } catch {}
  for (const name of strays)
    out.push(
      // a name inscope could not have made: say so, never paste it into a command
      !POOL_NAME_RE.test(name)
        ? {
            status: "warn",
            label: "proxy",
            detail: `unexpected entry "${name}" in ${contractTilde(path.join(proxyRoot(), "pools"))} or ~/Library/LaunchAgents; remove it by hand`,
          }
        : {
            status: "warn",
            label: `proxy ${name}`,
            detail: `pool ${name} is not in the config but its proxy is still installed; remove it with \`launchctl bootout gui/$(id -u)/${proxyLabel(name)}; rm -f ${contractTilde(launchAgentPath(name))}; rm -rf ${contractTilde(poolDir(name))}\``,
          },
    )
  const key = readProxyKey(run)
  const seen = new Map<string, string>()
  for (const { name, port } of pools) {
    const label = name === DEFAULT_POOL ? "proxy" : `proxy ${name}`
    const poolFix = `run \`inscope proxy setup${poolFlag(name)}\``
    const mine: Check[] = []
    try {
      if ((fs.statSync(proxyConfigPath(name)).mode & 0o077) !== 0)
        mine.push({
          status: "warn",
          label,
          detail: `${contractTilde(proxyConfigPath(name))} is readable by others (it holds the client key); ${poolFix}`,
        })
    } catch {
      mine.push({
        status: "fail",
        label,
        detail: `no ${contractTilde(proxyConfigPath(name))}; ${poolFix}`,
      })
    }
    try {
      if ((fs.statSync(proxyAuthDir(name)).mode & 0o077) !== 0)
        mine.push({
          status: "warn",
          label,
          detail: `${contractTilde(proxyAuthDir(name))} is readable by others (it holds account tokens); run \`chmod 700 ${contractTilde(proxyAuthDir(name))}\``,
        })
    } catch {}
    // A pool left on an older client key rejects every login's requests while running.
    if (key && fs.existsSync(proxyConfigPath(name)) && !poolHasKey(name, key))
      mine.push({
        status: "fail",
        label,
        detail: `its config has a different client key than the Keychain; ${poolFix}`,
      })
    const listening = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0
    if (!proxyLoaded(run, name) || !listening)
      mine.push({
        status: "fail",
        label,
        detail: `not running on ${proxyUrl(port)}; run \`inscope proxy start\``,
      })
    const accounts = proxyAccounts(name)
    if (!accounts.length)
      mine.push({
        status: "warn",
        label,
        detail: `no accounts signed in; run \`inscope login${poolFlag(name)}\``,
      })
    // An account in two pools has its single-use refresh token used by two proxies.
    for (const a of accounts) {
      const other = seen.get(a.email.toLowerCase())
      if (other)
        mine.push({
          status: "fail",
          label,
          detail: `${a.email} is also in pool ${other}; sign it out of one (\`inscope logout\`)`,
        })
      else seen.set(a.email.toLowerCase(), name)
    }
    if (!mine.some((c) => c.status === "fail"))
      mine.unshift({
        status: "ok",
        label,
        detail: `${proxyUrl(port)} · CLIProxyAPI ${PROXY_VERSION} · ${accounts.length} account(s)`,
      })
    out.push(...mine)
  }
  return out
}

// An isolated workspace runs Claude from a workspace-local `.inscope`. What can go
// wrong: it is not routed the way the config says, it is not signed in yet (only
// without the proxy; apply scaffolds an empty dir, which Claude fills on first login),
// and the dir, which holds its history and maybe a login, could be committed. Warnings
// only; none is a hard failure.
const isolateChecks = (ws: Workspace, cfg: Config, run: Runner): Check[] => {
  const tag = `[${ws.name}] claude`
  const dir = inscopeDirPath(ws)
  const out: Check[] = []
  const drift = routingDrift(dir, cfg, ws)
  out.push(
    drift
      ? { status: "warn", label: tag, detail: `this isolated login ${drift}` }
      : routeFor(cfg, ws)
        ? {
            status: "ok",
            label: tag,
            detail: `isolated in ${contractTilde(dir)}, through the proxy${ws.pool ? ` (pool ${ws.pool})` : ""}`,
          }
        : inscopeSignedIn(dir)
          ? { status: "ok", label: tag, detail: `isolated login in ${contractTilde(dir)}` }
          : {
              status: "warn",
              label: tag,
              detail: `${contractTilde(dir)} is empty; launch \`claude\` there once to sign in, or sign accounts in to the proxy with \`inscope login\``,
            },
  )
  out.push(...bypassChecks(tag, ws, cfg.bypass ?? false))
  // git ls-files exits 0 only if something under .inscope is tracked; a non-repo
  // (status 128) or a clean, ignored dir does not warn.
  const tracked = run("git", [
    "-C",
    resolveAbsolute(ws.path),
    "ls-files",
    "--error-unmatch",
    INSCOPE_DIR,
  ])
  if (tracked.status === 0)
    out.push({
      status: "warn",
      label: tag,
      detail: `${INSCOPE_DIR} holds this workspace's Claude config and is tracked by git; run \`git rm -r --cached ${INSCOPE_DIR}\``,
    })
  return out
}

// A workspace's skills are symlinks in its personal Claude skills dir (skillsDir).
// Warn on any the config declares (including the default self-skill) that is not
// linked, i.e. apply has not run since it was added, or a source went missing. All
// present is one ok line.
const skillChecks = (ws: Workspace, cfg: Config): Check[] => {
  const desired = desiredSkillLinks(ws)
  if (!desired.length) return []
  const tag = `[${ws.name}] skills`
  // Stale = missing, pointing at the old source after a re-point, or shadowed by a
  // user-authored dir (skillLinkTarget returns null for a non-symlink).
  const stale = desired.filter((d) => skillLinkTarget(ws, d.name) !== d.target)
  if (!stale.length) return [{ status: "ok", label: tag, detail: `${desired.length} linked` }]
  const specs = new Map((ws.skills ?? []).map((sp) => [normalizeSkill(sp).name, sp]))
  return stale.map((d) => {
    // apply cannot fix a name held by something else; say what holds it instead
    const spec = specs.get(d.name)
    const held = foreignSkillAt(ws, d.name) ?? (spec ? sharedNameClash(cfg, ws, spec) : null)
    return {
      status: "warn" as const,
      label: tag,
      detail: held
        ? `"${d.name}" not linked: ${held}`
        : `"${d.name}" not linked to its source; run \`inscope apply\``,
    }
  })
}

export const runDoctor = (cfg: Config, run: Runner = defaultRunner): Check[] => {
  const checks: Check[] = []

  if (!isMacOS()) {
    checks.push({
      status: "warn",
      label: "platform",
      detail: "inscope's secret resolution targets macOS (gh keyring + Keychain)",
    })
  }

  // inscope writes its source line to ~/.zshrc and the hook is zsh; a login
  // shell that is not zsh would never load it. Warn so it is not silently inert.
  const shell = process.env.SHELL ?? ""
  if (shell && !/(^|\/)zsh$/.test(shell)) {
    checks.push({
      status: "warn",
      label: "shell",
      detail: `login shell is ${path.basename(shell)}; inscope targets zsh (the hook is written to ~/.zshrc)`,
    })
  }

  const hookFile = hookPath()
  const current = readFileOrNull(hookFile)
  if (current === null) {
    checks.push({
      status: "fail",
      label: "hook",
      detail: `missing ${hookFile}; run \`inscope apply\``,
    })
  } else if (current !== renderHook(cfg)) {
    checks.push({
      status: "warn",
      label: "hook",
      detail: "out of date; run `inscope apply`",
    })
  } else {
    checks.push({ status: "ok", label: "hook", detail: hookFile })
  }

  checks.push(
    zshrcSourcesHook()
      ? { status: "ok", label: "zshrc", detail: "sources the hook" }
      : {
          status: "warn",
          label: "zshrc",
          detail: "does not source the hook; run `inscope apply`",
        },
  )

  if (cfg.bypass && bypassDisabledByPolicy()) {
    checks.push({
      status: "warn",
      label: "bypass",
      detail:
        "org managed settings disable bypassPermissions; the bypass setting in isolated logins is ignored",
    })
  }

  const needsGit = cfg.workspaces.some(hasGitIdentity)
  let markersErr: string | null = null
  try {
    assertBlockWellFormed(gitconfigPath(), GITCONFIG_BLOCK_ID)
  } catch (err) {
    markersErr = err instanceof Error ? err.message : String(err)
  }
  if (markersErr) {
    // apply refuses such a file, so "run inscope apply" would be a dead end
    checks.push({ status: "fail", label: "gitconfig", detail: markersErr })
  } else if (needsGit) {
    checks.push(
      readBlock(gitconfigPath(), GITCONFIG_BLOCK_ID) !== null
        ? {
            status: "ok",
            label: "gitconfig",
            detail: "includeIf block present",
          }
        : {
            status: "fail",
            label: "gitconfig",
            detail: "missing includeIf block; run `inscope apply`",
          },
    )
  }

  checks.push(...proxyChecks(cfg, run))
  // The shared base login, which every non-isolated directory runs on.
  const baseDrift = routingDrift(baseClaudeDir(), cfg)
  if (baseDrift)
    checks.push({ status: "warn", label: "claude", detail: `the shared login ${baseDrift}` })
  else if (routeFor(cfg))
    checks.push({
      status: "ok",
      label: "claude",
      detail: `the shared login (${contractTilde(baseClaudeDir())}) goes through the proxy`,
    })

  for (const ws of cfg.workspaces) {
    const tag = `[${ws.name}]`

    if (ws.gh) {
      checks.push(
        ghToken(ws.gh, run)
          ? { status: "ok", label: `${tag} gh`, detail: `token for ${ws.gh}` }
          : {
              status: "fail",
              label: `${tag} gh`,
              detail: `no token for ${ws.gh}; run \`gh auth login\``,
            },
      )
    }

    if (ws.isolate) checks.push(...isolateChecks(ws, cfg, run))

    if (ws.servers.slack) {
      const svc = ws.servers.slack.keychain
      checks.push(
        keychainHas(svc, run)
          ? { status: "ok", label: `${tag} slack`, detail: svc }
          : {
              status: "fail",
              label: `${tag} slack`,
              detail: `${svc} not in keychain; run \`${keychainSetCommand(svc)}\``,
            },
      )
    }

    if (ws.servers.nylas) {
      const svc = ws.servers.nylas.keychain
      checks.push(
        keychainHas(svc, run)
          ? { status: "ok", label: `${tag} nylas`, detail: svc }
          : {
              status: "fail",
              label: `${tag} nylas`,
              detail: `${svc} not in keychain; run \`${keychainSetCommand(svc, "nyk_...")}\``,
            },
      )
    }

    if (hasGitIdentity(ws)) {
      const file = perWorkspaceGitconfigPath(ws.name)
      if (!fs.existsSync(file)) {
        checks.push({
          status: "fail",
          label: `${tag} git`,
          detail: `missing ${file}; run \`inscope apply\``,
        })
      } else if (ws.git?.email) {
        const actual = gitEmailForFile(file, run)
        checks.push(
          actual === ws.git.email
            ? { status: "ok", label: `${tag} git`, detail: ws.git.email }
            : {
                status: "fail",
                label: `${tag} git`,
                detail: `email is ${actual ?? "unset"}, expected ${ws.git.email}`,
              },
        )
      }
    }

    const mcpErr = mcpError(ws)
    if (mcpErr) {
      // apply (readDocOrThrow) refuses an unparseable file, so this is a fail,
      // not "out of date" with a misleading clean-rewrite diff
      checks.push({ status: "fail", label: `${tag} mcp`, detail: mcpErr })
    } else {
      const doc = readMcp(ws)
      if (doc === null) {
        checks.push({
          status: "warn",
          label: `${tag} mcp`,
          detail: "no .mcp.json; run `inscope apply`",
        })
      } else {
        const managed = managedKeys(ws.name).filter((k) => doc.mcpServers?.[k])
        checks.push({
          status: "ok",
          label: `${tag} mcp`,
          detail: `${managed.length} server(s)`,
        })
        // content drift, mirroring the hook check's exactness (a present-but-stale
        // managed server otherwise slips past the count above)
        if (readFileOrNull(mcpFilePath(ws)) !== mcpTarget(ws)) {
          checks.push({
            status: "warn",
            label: `${tag} mcp`,
            detail: "out of date; run `inscope diff`",
          })
        }
        const loose = unpinnedServers(doc)
        if (loose.length) {
          checks.push({
            status: "warn",
            label: `${tag} mcp`,
            detail: `unpinned: ${loose.join(", ")}`,
          })
        }
      }
    }

    checks.push(...skillChecks(ws, cfg))
  }

  // Claude Code ranks ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY above apiKeyHelper, so
  // either one exported in this shell silently bypasses the proxy's key. One check.
  const shadow = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].filter((k) => process.env[k])
  if (shadow.length && routeFor(cfg))
    checks.push({
      status: "warn",
      label: "proxy",
      detail:
        shadow.length > 1
          ? `${shadow.join(" and ")} are set in this shell and outrank the proxy's key; unset them`
          : `${shadow[0]} is set in this shell and outranks the proxy's key; unset it`,
    })

  return checks
}
