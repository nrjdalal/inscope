import { parseArgs } from "node:util"

import { saveConfig, validateConfig } from "@/config"
import { adoptable, computeDrift, diffLines } from "@/drift"
import { contractTilde } from "@/env"
import { requireConfig } from "~/bin/commands/_config"
import { orange, red } from "~/bin/commands/_prompt"
import { name } from "~/package.json"

// Diff coloring in GitHub's dark-mode diff palette: additions green, deletions
// red, each filled to the terminal width so the line reads as a full-width band.
// 24-bit color (text + the subtle line background GitHub uses):
//   add: text #3fb950 on bg #12261e (rgba(46,160,67,0.15) over the dark canvas)
//   del: text #f85149 on bg #301b1f (rgba(248,81,73,0.15) over the dark canvas)
// No-op when stdout is not a TTY (piped output stays plain), matching `orange`.
const colorizeDiff = (text: string): string => {
  if (!process.stdout.isTTY) return text
  const cols = process.stdout.columns || 80
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ") && !line.startsWith("+ ")) return line
      const pad = " ".repeat(Math.max(0, cols - line.length))
      const color = line.startsWith("- ")
        ? "48;2;48;27;31;38;2;248;81;73"
        : "48;2;18;38;30;38;2;63;185;80"
      return `\x1b[${color}m${line}${pad}\x1b[0m`
    })
    .join("\n")
}

const helpMessage = `Show what \`${name} apply\` would change: a diff of each managed
artifact (the zsh hook, git includes, .mcp.json files, and workspace skills)
against what your config would generate. Read-only.

With --adopt, pull settings that exist in your .mcp.json but not your config
(a Slack add-message tool or package, a custom server URL) back into the config, so the
next apply keeps them instead of dropping them.

Usage:
  $ ${name} diff [--adopt] [--exit-code]

Options:
      --adopt       Write config-expressible on-disk settings back into the config
      --exit-code   Exit 1 if anything is out of sync (for CI / pre-commit gates)
  -h, --help        Display help message`

export const diff = (args: string[]) => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      adopt: { type: "boolean" },
      "exit-code": { type: "boolean" },
    },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const cfg = requireConfig()

  if (values.adopt) {
    const { cfg: next, changes } = adoptable(cfg)
    if (!changes.length) {
      console.log("\nNothing to adopt: the config already covers your .mcp.json settings.")
      process.exit(0)
    }
    validateConfig(next)
    saveConfig(next)
    console.log("\nAdopted into config:")
    for (const c of changes) console.log(`  ${c}`)
    console.log(`\nRun ${orange(`${name} apply`)} to regenerate from the updated config.`)
    process.exit(0)
  }

  const drifts = computeDrift(cfg)
  if (!drifts.length) {
    console.log("\nIn sync. `apply` would change nothing.")
    process.exit(0)
  }

  // --exit-code makes drift a non-zero exit so `inscope diff --exit-code` can
  // gate CI / pre-commit ("is everything applied?"). Default stays 0: the plain
  // diff is a read-only preview, not a failure.
  const driftExit = values["exit-code"] ? 1 : 0

  for (const d of drifts) {
    console.log(`\n${orange(`${contractTilde(d.path)} (${d.label})`)}`)
    if (d.error) console.log(red(`  ${d.error}`))
    else console.log(colorizeDiff(diffLines(d.current, d.next)))
  }

  const { changes } = adoptable(cfg)
  if (changes.length) {
    console.log(`\nThese .mcp.json settings aren't in your config, so \`apply\` would drop them:`)
    for (const c of changes) console.log(`  ${c}`)
    console.log(
      `\nRun ${orange(`${name} diff --adopt`)} to keep them by writing them into the config.`,
    )
  }

  process.exit(driftExit)
}
