import fs from "node:fs"
import path from "node:path"
import { ZSHRC_BLOCK_ID } from "@/apply"
import type { Config, Workspace } from "@/config"
import { gitconfigPath, hookPath, resolveAbsolute, zshrcPath } from "@/env"
import {
  GITCONFIG_BLOCK_ID,
  hasGitIdentity,
  perWorkspaceGitconfigPath,
} from "@/generators/gitconfig"
import { renderHook } from "@/generators/hook"
import { managedKeys, readMcp } from "@/generators/mcp"
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

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

const unpinnedServers = (doc: Record<string, any> | null): string[] => {
  const out: string[] = []
  const servers = doc?.mcpServers
  if (!servers || typeof servers !== "object") return out
  for (const [name, def] of Object.entries<any>(servers)) {
    const args: string[] = Array.isArray(def?.args) ? def.args : []
    if (args.some((a) => typeof a === "string" && /@latest$/.test(a))) {
      out.push(name)
    } else if (def?.command === "npx") {
      const pkg = args.find((a) => typeof a === "string" && !a.startsWith("-"))
      if (pkg && !pkg.includes("@")) out.push(name)
    }
  }
  return out
}

export const currentWorkspace = (
  cfg: Config,
  cwd: string = process.cwd(),
): Workspace | undefined => {
  const abs = path.resolve(cwd)
  return cfg.workspaces.find((w) => {
    const root = resolveAbsolute(w.path)
    return abs === root || abs.startsWith(root + path.sep)
  })
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

export const runDoctor = (
  cfg: Config,
  run: Runner = defaultRunner,
): Check[] => {
  const checks: Check[] = []

  if (!isMacOS()) {
    checks.push({
      status: "warn",
      label: "platform",
      detail: "inscope's secret resolution targets macOS (gh keyring + Keychain)",
    })
  }

  const hookFile = hookPath()
  const current = read(hookFile)
  if (current === null) {
    checks.push({
      status: "fail",
      label: "hook",
      detail: `missing ${hookFile}; run \`inscope init\``,
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
    readBlock(zshrcPath(), ZSHRC_BLOCK_ID) !== null
      ? { status: "ok", label: "zshrc", detail: "sources the hook" }
      : {
          status: "warn",
          label: "zshrc",
          detail: "does not source the hook; run `inscope init`",
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

  return checks
}
