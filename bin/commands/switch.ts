import { parseArgs } from "node:util"

import { activeAccount, isSignedIn, nextSignedIn, poolFor, repointSymlink } from "@/accounts"
import {
  type Config,
  configExists,
  currentWorkspace,
  findWorkspace,
  loadConfig,
  type Workspace,
} from "@/config"
import { applyBypass } from "@/generators/settings"
import { applySkills } from "@/generators/skills"
import { name } from "~/package.json"

const helpMessage = (verb: string) => `Switch a workspace's active Claude account by
re-pointing its .inscope symlink. Effective on the next \`claude\` launch. With no
<account>, picks the next signed-in account in the pool (useful when one is limited).

Usage:
  $ ${name} ${verb} [account] [--workspace <label>]

Options:
  -w, --workspace <label>  Target another workspace (default: the current directory)
  -h, --help               Display help message`

const resolvePooled = (cfg: Config, flag?: string): Workspace => {
  const ws =
    (flag ? findWorkspace(cfg, flag) : currentWorkspace(cfg)) ??
    (!flag && cfg.workspaces.length === 1 ? cfg.workspaces[0] : undefined)
  if (!ws) {
    console.error(`Run this inside a workspace, or pass --workspace <label>.`)
    process.exit(1)
  }
  if (!poolFor(ws).length) {
    console.error(
      `Workspace "${ws.name}" has no account pool. Give it \`"accounts": [...]\` (needs isolate), then \`${name} apply\`.`,
    )
    process.exit(1)
  }
  return ws
}

const run = (verb: string) => (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, workspace: { type: "string", short: "w" } },
    args,
  })
  if (values.help) {
    console.log(helpMessage(verb))
    process.exit(0)
  }
  if (!configExists()) {
    console.error(`No config found. Run \`${name} add <path>\` first.`)
    process.exit(1)
  }
  const cfg = loadConfig()
  const ws = resolvePooled(cfg, values.workspace)
  const pool = poolFor(ws)
  const current = activeAccount(ws)

  let target = positionals[0]
  if (!target) {
    const next = nextSignedIn(ws, current)
    if (!next) {
      console.error(
        `No signed-in account available in ${ws.name}'s pool. Sign one in with \`${name} account add <name>\`.`,
      )
      process.exit(1)
    }
    target = next
  }
  if (!pool.includes(target)) {
    console.error(`"${target}" is not in ${ws.name}'s pool (${pool.join(", ")}).`)
    process.exit(1)
  }
  if (!isSignedIn(target)) {
    console.error(`Account "${target}" is not signed in. Run \`${name} account add ${target}\`.`)
    process.exit(1)
  }
  if (target === current) {
    console.log(`${ws.name} is already on "${target}".`)
    process.exit(0)
  }

  repointSymlink(ws, target)
  // Equip the newly-active account: bypass + skills write through the .inscope
  // symlink into it (Claude only ever reads the active one).
  applyBypass(ws, cfg.bypass ?? false)
  applySkills(cfg)
  console.log(`\n✓ ${ws.name}: ${current ?? "(none)"} -> ${target}`)
  console.log(`Relaunch \`claude\` from ${ws.path} to use ${target}.`)
  process.exit(0)
}

export const use = run("use")
export const switchAccount = run("switch")
