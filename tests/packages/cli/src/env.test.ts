import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { packageRoot } from "@/env"
import { selfSkillSource } from "@/generators/skills"

// The repo root's package.json is named inscope too: these pin that the walk stops at packages/cli, which ships skills/inscope.
const cli = path.resolve(import.meta.dir, "..", "..", "..", "..", "packages", "cli")
const bin = path.join(cli, "dist", "bin", "index.mjs")

test("packageRoot resolves to packages/cli from the source, where the self-skill ships", () => {
  expect(packageRoot()).toBe(cli)
  expect(fs.existsSync(path.join(selfSkillSource(), "SKILL.md"))).toBe(true)
})

// `bun run test` builds packages/* first, so the bundle exists in CI and after a build.
test.skipIf(!fs.existsSync(bin))("the built CLI finds and links the bundled self-skill", () => {
  const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inscope-root-")))
  const ws = path.join(sb, "w")
  fs.mkdirSync(path.join(sb, ".config", "inscope"), { recursive: true })
  fs.mkdirSync(ws)
  fs.writeFileSync(
    path.join(sb, ".config", "inscope", "inscope.json"),
    JSON.stringify({ version: 1, workspaces: [{ name: "w", path: ws, servers: {} }] }),
  )
  // sealed off from the real machine like sandboxCli: no inherited login, base, or token
  const env: Record<string, string | undefined> = {
    ...process.env,
    GH_CONFIG_DIR: path.join(sb, ".gh"),
    HOME: sb,
    XDG_CONFIG_HOME: path.join(sb, ".config"),
  }
  for (const k of [
    "CLAUDE_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "INSCOPE_BASE_CCD",
    "INSCOPE_CCD",
  ])
    delete env[k]
  const run = (args: string[]) => spawnSync("node", [bin, ...args], { encoding: "utf8", env })
  try {
    expect(run(["apply"]).status).toBe(0)
    expect(run(["skill", "list", "-w", "w"]).stdout).toMatch(
      /\n {2}inscope +\(bundled self-skill\) {2}✓ linked\n/,
    )
  } finally {
    fs.rmSync(sb, { recursive: true, force: true })
  }
})
