import { parseArgs } from "node:util"
import { configExists, loadConfig } from "@/config"
import {
  currentWorkspace,
  liveSnapshot,
  runDoctor,
  type CheckStatus,
} from "@/doctor"
import { name } from "~/package.json"

const helpMessage = `Verify the setup: gh tokens resolve, keychain entries exist,
git emails match per path, the hook is current, and no MCP server is unpinned.
Exits non-zero if any check fails.

Usage:
  $ ${name} doctor

Options:
  -h, --help  Display help message`

const symbol: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" }

export const doctor = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  if (!configExists()) {
    console.error(`No config found. Run \`${name} init\` first.`)
    process.exit(1)
  }

  const cfg = loadConfig()
  const checks = runDoctor(cfg)

  for (const c of checks) {
    console.log(
      `${symbol[c.status]} ${c.label}${c.detail ? `  ${c.detail}` : ""}`,
    )
  }

  const here = currentWorkspace(cfg)
  if (here) {
    const snap = liveSnapshot()
    console.log(`\nThis shell (${here.name}):`)
    console.log(`  pwd    ${snap.pwd}`)
    console.log(`  gh     ${snap.gh}`)
    console.log(`  git    ${snap.gitEmail}`)
    console.log(`  token  ${snap.tokenSet ? "set" : "unset"}`)
  }

  const failed = checks.filter((c) => c.status === "fail").length
  if (failed) {
    console.log(`\n${failed} check(s) failed.`)
    process.exit(1)
  }
  console.log(`\nAll checks passed.`)
  process.exit(0)
}
