import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "@/config"

const FAKES = path.join(import.meta.dir, "bin")
const ENTRY = path.join(import.meta.dir, "..", "..", "bin", "index.ts")

// A throwaway HOME for running the real CLI: config, Claude dirs, and LaunchAgents all
// live in it, and fake `security`, `launchctl`, `claude`, and Chrome come first on
// PATH, so nothing reaches the real Keychain, launchd, or logins. The fakes refuse to
// run outside a dir like this one (an `inscope-acct-*` temp dir). Every variable that
// could point a command at a real login is dropped.
export const sandbox = () => {
  const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inscope-acct-")))
  const state = path.join(sb, ".fake")
  fs.mkdirSync(state)
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${FAKES}:${process.env.PATH}`,
    HOME: sb,
    XDG_CONFIG_HOME: path.join(sb, ".config"),
    GH_CONFIG_DIR: path.join(sb, ".gh"),
    FAKE_SANDBOX: sb,
    FAKE_STATE: state,
    INSCOPE_CHROME: path.join(FAKES, "chrome"),
  }
  for (const k of [
    "CLAUDE_CONFIG_DIR",
    "INSCOPE_CCD",
    "INSCOPE_BASE_CCD",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "BROWSER",
    "NODE_OPTIONS",
  ])
    delete env[k]
  const cli = (args: string[], extra: Record<string, string> = {}, cwd?: string) =>
    spawnSync("bun", [ENTRY, ...args], { encoding: "utf8", env: { ...env, ...extra }, cwd })
  // Async, for commands that call an in-process emulator: spawnSync would block the
  // event loop the emulator answers on.
  const cliAsync = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("bun", [ENTRY, ...args], { env: { ...env, ...extra } })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("close", (status) => resolve({ status, stdout, stderr }))
    })
  const cfgFile = path.join(sb, ".config", "inscope", "inscope.json")
  const readCfg = (): Config | null =>
    fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : null
  const writeCfg = (cfg: unknown) => {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n")
  }
  const keychain = (): Record<string, string> => {
    const f = path.join(state, "keychain.json")
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}
  }
  const setKeychain = (k: Record<string, string>) =>
    fs.writeFileSync(path.join(state, "keychain.json"), JSON.stringify(k, null, 2))
  const calls = (tool: "claude" | "chrome" | "launchctl"): any[] => {
    const f = path.join(state, `${tool}-calls.jsonl`)
    return fs.existsSync(f)
      ? fs
          .readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : []
  }
  // run the fake claude directly (e.g. to sign the base login in)
  const fakeClaude = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(path.join(FAKES, "claude"), args, { encoding: "utf8", env: { ...env, ...extra } })
  return { sb, env, cli, cliAsync, readCfg, writeCfg, keychain, setKeychain, calls, fakeClaude }
}
