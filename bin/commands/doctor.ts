import { parseArgs } from "node:util"

import { configExists, loadConfig } from "@/config"
import { currentWorkspace, liveSnapshot, runDoctor, type CheckStatus } from "@/doctor"
import { green, red, yellow } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

const helpMessage = `Verify the setup: gh tokens resolve, keychain entries exist,
git emails match per path, the hook is current, and no MCP server is unpinned.
Exits non-zero if any check fails.

Usage:
  $ ${name} doctor

Options:
      --json  Print the checks (and this shell's snapshot) as JSON
  -h, --help  Display help message`

const symbol: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" }
const paint: Record<CheckStatus, (s: string) => string> = { ok: green, warn: yellow, fail: red }

export const doctor = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, json: { type: "boolean" } },
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
  const checks = runDoctor(cfg)
  const failed = checks.filter((c) => c.status === "fail").length

  if (values.json) {
    const here = currentWorkspace(cfg)
    const shell = here ? { workspace: here.name, ...liveSnapshot() } : null
    console.log(JSON.stringify({ checks, shell, ok: failed === 0, failed }, null, 2))
    process.exit(failed ? 1 : 0)
  }

  const report = checks
    .map((c) => `${paint[c.status](symbol[c.status])} ${c.label}${c.detail ? `  ${c.detail}` : ""}`)
    .join("\n")
  console.log(`\n${report}`)

  const here = currentWorkspace(cfg)
  if (here) {
    const snap = liveSnapshot()
    console.log(`\nThis shell (${here.name}):`)
    console.log(`  pwd    ${snap.pwd}`)
    console.log(`  gh     ${snap.gh}`)
    console.log(`  git    ${snap.gitEmail}`)
    console.log(`  token  ${snap.tokenSet ? "set" : "unset"}`)
  }

  if (failed) {
    console.log(`\n${red(`${failed} check(s) failed.`)}`)
    process.exit(1)
  }
  console.log(`\n${green("All checks passed.")}`)
  process.exit(0)
}
