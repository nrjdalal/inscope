// A sealed, deterministic inscope machine for the dashboard's tests and screenshots: its own HOME, stub gh/claude/security on PATH, three workspaces applied by the real CLI, then drifted on purpose. Run `bun tests/inscope/sandbox.ts [--dir <path>]` to seed one and print its env as KEY=VALUE lines.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The fake credentials the stubs hand out: a test asserts none of them ever reaches a response.
export const SECRETS = ["gho_demo_token", "xoxp-demo-secret", "sk-should-be-redacted"] as const

const REPO = path.resolve(import.meta.dir, "..", "..")
const CLI = path.join(REPO, "packages", "cli", "bin", "index.ts")

const GH = `#!/bin/sh
# gh auth token -u <account>: demo-acme has no token, every other account does
if [ "$1 $2" = "auth token" ]; then
  [ "$4" = "demo-acme" ] && exit 1
  echo "gho_demo_token"; exit 0
fi
if [ "$1 $2" = "auth status" ]; then
  echo "github.com"
  echo "  ✓ Logged in to github.com account demo-personal (keyring)"
  echo "  ✓ Logged in to github.com account demo-work (keyring)"
  exit 0
fi
exit 1
`

const CLAUDE = `#!/bin/sh
# claude auth status --json, keyed on the login dir the caller pinned
[ "$1 $2 $3" = "auth status --json" ] || exit 1
case "$CLAUDE_CONFIG_DIR" in
  */work/.inscope) echo '{"loggedIn":true,"email":"work@example.com","subscriptionType":"team","orgName":"Example Co"}' ;;
  */acme/.inscope) echo '{"loggedIn":false}' ;;
  *) echo '{"loggedIn":true,"email":"personal@example.com","subscriptionType":"max"}' ;;
esac
`

const SECURITY = `#!/bin/sh
# security find-generic-password ... -s <service> -w: only the work Slack token is stored
service=""
while [ $# -gt 0 ]; do
  [ "$1" = "-s" ] && service="$2"
  shift
done
[ "$service" = "SLACK_MCP_XOXP_TOKEN_WORK" ] && { echo "xoxp-demo-secret"; exit 0; }
exit 44
`

export type Sandbox = { root: string; home: string; env: Record<string, string> }

// The sealed environment every process touching the sandbox runs with: nothing from the developer's own logins can leak in.
const sealedEnv = (root: string): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  for (const key of [
    "CLAUDE_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GIT_CONFIG_GLOBAL",
    "INSCOPE_BASE_CCD",
    "INSCOPE_CCD",
    "SLACK_MCP_XOXP_TOKEN",
  ])
    delete env[key]
  const home = path.join(root, "home")
  return {
    ...env,
    GH_CONFIG_DIR: path.join(root, "gh"),
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    PATH: `${path.join(root, "bin")}${path.delimiter}${env.PATH ?? ""}`,
    SHELL: "/bin/zsh",
    USER: "demo",
    XDG_CONFIG_HOME: path.join(home, ".config"),
  }
}

const write = (file: string, content: string, mode?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mode) fs.chmodSync(file, mode)
}

export const seedSandbox = (dir?: string): Sandbox => {
  const target = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "inscope-dashboard-"))
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  // realpath: macOS temp dirs resolve through /private, and inscope compares resolved paths
  const root = fs.realpathSync(target)
  const home = path.join(root, "home")
  const env = sealedEnv(root)

  write(path.join(root, "bin", "gh"), GH, 0o755)
  write(path.join(root, "bin", "claude"), CLAUDE, 0o755)
  write(path.join(root, "bin", "security"), SECURITY, 0o755)
  fs.mkdirSync(path.join(root, "gh"), { recursive: true })
  write(
    path.join(root, "skills", "readme-audit", "SKILL.md"),
    "---\nname: readme-audit\ndescription: Audit a README.\n---\n",
  )

  for (const ws of ["personal", "work", path.join("clients", "acme")]) {
    fs.mkdirSync(path.join(home, ws), { recursive: true })
    spawnSync("git", ["init", "-q"], { cwd: path.join(home, ws), env })
  }

  write(
    path.join(home, ".config", "inscope", "inscope.json"),
    `${JSON.stringify(
      {
        version: 1,
        workspaces: [
          {
            name: "personal",
            path: "~/personal",
            gh: "demo-personal",
            git: { email: "personal@example.com" },
            servers: { github: true },
          },
          {
            isolate: true,
            name: "work",
            path: "~/work",
            gh: "demo-work",
            git: { email: "work@example.com" },
            servers: {
              github: true,
              linear: true,
              slack: { keychain: "SLACK_MCP_XOXP_TOKEN_WORK" },
            },
            skills: [path.join(root, "skills", "readme-audit")],
          },
          {
            isolate: true,
            name: "acme",
            path: "~/clients/acme",
            gh: "demo-acme",
            git: { email: "dev@acme.example" },
            servers: {
              github: true,
              notion: true,
              slack: { keychain: "SLACK_MCP_XOXP_TOKEN_ACME" },
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  )

  const applied = spawnSync("bun", [CLI, "apply"], { cwd: home, encoding: "utf8", env })
  if (applied.status !== 0)
    throw new Error(`inscope apply failed in the sandbox:\n${applied.stderr}`)

  // the work login is signed in: Claude leaves its state file in the login dir
  write(path.join(home, "work", ".inscope", ".claude.json"), '{"oauthAccount":{}}\n')

  // drift work/.mcp.json by hand: a changed URL, plus a server of the user's own that carries a literal key
  const mcpFile = path.join(home, "work", ".mcp.json")
  const mcp = JSON.parse(fs.readFileSync(mcpFile, "utf8"))
  mcp.mcpServers["linear-work"].url = "https://mcp.linear.app/sse-old"
  mcp.mcpServers.mine = {
    command: "npx",
    args: ["-y", "my-mcp"],
    env: { MY_API_KEY: "sk-should-be-redacted" },
  }
  write(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`)

  // acme's .mcp.json was never written (or was deleted)
  fs.rmSync(path.join(home, "clients", "acme", ".mcp.json"), { force: true })

  // an inscope link no workspace declares any more, and a skill folder of the user's own
  const workSkills = path.join(home, "work", ".inscope", "skills")
  const orphan = path.join(home, ".config", "inscope", "skills-cache", "local", "old-notes")
  write(path.join(orphan, "SKILL.md"), "---\nname: old-notes\ndescription: Old notes.\n---\n")
  fs.symlinkSync(orphan, path.join(workSkills, "old-notes"))
  write(
    path.join(workSkills, "my-notes", "SKILL.md"),
    "---\nname: my-notes\ndescription: Mine.\n---\n",
  )

  return { root, home, env }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--dir")
  const { env } = seedSandbox(flag === -1 ? undefined : process.argv[flag + 1])
  for (const key of [
    "GH_CONFIG_DIR",
    "GIT_CONFIG_NOSYSTEM",
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "XDG_CONFIG_HOME",
  ])
    console.log(`${key}=${env[key]}`)
}
