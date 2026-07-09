import fs from "node:fs"
import path from "node:path"

import { zshrcSourcesHook } from "@/apply"
import { type Config, type Workspace } from "@/config"
import { mcpError, mcpTarget } from "@/drift"
import { contractTilde, gitconfigPath, hookPath, resolveAbsolute } from "@/env"
import {
  GITCONFIG_BLOCK_ID,
  hasGitIdentity,
  perWorkspaceGitconfigPath,
} from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { INSCOPE_DIR, inscopeDirPath, inscopeSignedIn } from "@/generators/isolate"
import { managedKeys, mcpFilePath, readMcp, slackPackageSpec } from "@/generators/mcp"
import { hasBypassSetting } from "@/generators/settings"
import { desiredSkillLinks, skillLinkTarget } from "@/generators/skills"
import { readFileOrNull } from "@/io"
import { readBlock } from "@/managed-block"
import {
  defaultRunner,
  ghToken,
  gitEmailForFile,
  isMacOS,
  keychainHas,
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

// An isolated workspace runs Claude from a workspace-local `.inscope`. Two things
// can go wrong: you have not signed in there yet (apply scaffolds an empty dir,
// which Claude fills on first login), and the dir, which holds that login, could
// be committed. Warn on both; neither is a hard failure.
const isolateChecks = (ws: Workspace, run: Runner, bypass: boolean): Check[] => {
  const tag = `[${ws.name}] claude`
  const dir = inscopeDirPath(ws)
  const out: Check[] = []
  out.push(
    inscopeSignedIn(dir)
      ? { status: "ok", label: tag, detail: `isolated login in ${contractTilde(dir)}` }
      : {
          status: "warn",
          label: tag,
          detail: `${contractTilde(dir)} is empty; launch \`claude\` there once to sign in`,
        },
  )
  // bypass drift, both directions: configured but not applied, and the dangerous
  // reverse, turned off in config but the login still auto-approves on disk.
  if (bypass && !hasBypassSetting(ws))
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
      detail: `${INSCOPE_DIR} holds a login and is tracked by git; run \`git rm -r --cached ${INSCOPE_DIR}\``,
    })
  return out
}

// A workspace's skills are symlinks in its personal Claude skills dir (skillsDir).
// Warn on any the config declares (including the default self-skill) that is not
// linked, i.e. apply has not run since it was added, or a source went missing. All
// present is one ok line.
const skillChecks = (ws: Workspace): Check[] => {
  const desired = desiredSkillLinks(ws)
  if (!desired.length) return []
  const tag = `[${ws.name}] skills`
  // Stale = missing, pointing at the old source after a re-point, or shadowed by a
  // user-authored dir (skillLinkTarget returns null for a non-symlink).
  const stale = desired.filter((d) => skillLinkTarget(ws, d.name) !== d.target)
  if (!stale.length) return [{ status: "ok", label: tag, detail: `${desired.length} linked` }]
  return stale.map((d) => ({
    status: "warn" as const,
    label: tag,
    detail: `"${d.name}" not linked to its source; run \`inscope apply\``,
  }))
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

  const needsGit = cfg.workspaces.some(hasGitIdentity)
  if (needsGit) {
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

    if (ws.isolate) checks.push(...isolateChecks(ws, run, cfg.bypass ?? false))

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

    checks.push(...skillChecks(ws))
  }

  return checks
}
