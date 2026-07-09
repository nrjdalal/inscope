import { parseArgs } from "node:util"

import { activeAccount, isPooled, isSignedIn, poolFor } from "@/accounts"
import { configExists, findWorkspace, loadConfig } from "@/config"
import { accountCap, fetchLiveUsage, type LiveUsage } from "@/usage"
import { dim, green, orange, red, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Show live Claude usage for each pooled workspace's accounts: the
5-hour and 7-day utilization (from Anthropic's own usage endpoint, read live, never
stored), which account is active, and any that are usage-limit-capped.

Usage:
  $ ${name} usage [--workspace <label>]

Options:
  -w, --workspace <label>  Only this workspace (default: every pooled workspace)
      --json               Print as JSON
  -h, --help               Display help message`

const bar = (pct: number, width = 10): string => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return "▓".repeat(filled) + "░".repeat(width - filled)
}

// Compact "Xh Ym" until a future timestamp (ms since epoch).
const until = (targetMs: number): string => {
  const s = Math.max(0, Math.floor((targetMs - Date.now()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

type Row = {
  name: string
  active: boolean
  signedIn: boolean
  capped: boolean
  resetAt?: number
  usage: LiveUsage | null
}

export const usage = async (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      workspace: { type: "string", short: "w" },
    },
    args,
  })
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  if (!configExists()) {
    console.error(`No config found. Run \`${name} add <path>\` first.`)
    process.exit(1)
  }

  const cfg = loadConfig()
  let pooled = cfg.workspaces.filter(isPooled)
  if (values.workspace) {
    const one = findWorkspace(cfg, values.workspace)
    pooled = one && isPooled(one) ? [one] : []
  }
  if (!pooled.length) {
    console.log(
      `No pooled workspaces. Give one \`"accounts": [...]\` (needs isolate), then \`${name} apply\`.`,
    )
    process.exit(0)
  }

  // Fetch every account's live usage in parallel (each token is per-account, so
  // separate rate-limit buckets). Cap state is a local read.
  const workspaces = await Promise.all(
    pooled.map(async (ws) => {
      const active = activeAccount(ws)
      const rows: Row[] = await Promise.all(
        poolFor(ws).map(async (n) => {
          const signedIn = isSignedIn(n)
          const cap = accountCap(n)
          return {
            name: n,
            active: n === active,
            signedIn,
            capped: cap.capped,
            resetAt: cap.resetAt,
            usage: signedIn ? await fetchLiveUsage(n) : null,
          }
        }),
      )
      return { workspace: ws.name, path: ws.path, active, accounts: rows }
    }),
  )

  if (values.json) {
    console.log(JSON.stringify(workspaces, null, 2))
    process.exit(0)
  }

  const win = (w?: { pct: number; resetAt?: string }) =>
    w ? `${bar(w.pct)} ${String(Math.round(w.pct)).padStart(3)}%` : dim("  unknown  ")
  for (const ws of workspaces) {
    console.log(`\n${ws.workspace}  ${dim(`(pool: ${ws.accounts.map((a) => a.name).join(", ")})`)}`)
    for (const a of ws.accounts) {
      const dot = a.signedIn ? green("●") : yellow("○")
      const mark = a.active ? orange("  ← active") : ""
      const label = a.name.padEnd(12)
      if (!a.signedIn) {
        console.log(`  ${dot} ${label} ${yellow("not signed in")}${mark}`)
      } else if (a.capped) {
        const when = a.resetAt ? ` (resets ${until(a.resetAt * 1000)})` : ""
        console.log(`  ${dot} ${label} ${red(`capped${when}`)}${mark}`)
      } else if (a.usage) {
        const five = win(a.usage.fiveHour)
        const seven = win(a.usage.sevenDay)
        const reset = a.usage.fiveHour?.resetAt
          ? dim(`  5h resets ${until(Date.parse(a.usage.fiveHour.resetAt))}`)
          : ""
        console.log(`  ${dot} ${label} 5h ${five}   7d ${seven}${reset}${mark}`)
      } else {
        console.log(
          `  ${dot} ${label} ${dim("usage unavailable (offline, or token in Keychain)")}${mark}`,
        )
      }
    }
  }
  process.exit(0)
}
