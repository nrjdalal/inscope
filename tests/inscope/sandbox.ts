// A sealed, deterministic inscope machine for the dashboard's tests and screenshots: its own HOME, stub gh/claude/security on PATH, three workspaces applied by the real CLI, then drifted on purpose. Run `bun tests/inscope/sandbox.ts [--dir <path>]` to seed one and print its env as KEY=VALUE lines.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// a token shaped like a GitHub one, put together at run time so no secret scanner reads one in this file
const VENDOR_TOKEN = `ghp_${"plantedvendortokenshouldberedacted00"}`

// The fake credentials the stubs hand out and the sandbox plants: a test asserts none of them ever reaches a response.
export const SECRETS = [
  "at-sign-pass-should-be-redacted",
  "bearer-should-be-redacted",
  "conn-should-be-redacted",
  "cookie-two-should-be-redacted",
  "default-token-should-be-redacted",
  "docker-env-should-be-redacted",
  "flag-in-string-should-be-redacted",
  "fragment-should-be-redacted",
  "gho_demo_token",
  VENDOR_TOKEN,
  "gitconfig-token-should-be-redacted",
  "header-bearer-should-be-redacted",
  "helper-bearer-should-be-redacted",
  "helper-password-should-be-redacted",
  "inline-env-should-be-redacted",
  "json-in-string-should-be-redacted",
  "lower-token-should-be-redacted",
  "nospace-should-be-redacted",
  "pg-pass-should-be-redacted",
  "query-token-should-be-redacted",
  "quoted-command-should-be-redacted",
  "quoted-conn-should-be-redacted",
  "quoted-header-should-be-redacted",
  "quoted-key-should-be-redacted",
  "single-quoted-should-be-redacted",
  "sk-should-be-redacted",
  "skill-url-token-should-be-redacted",
  "stale-skill-token-should-be-redacted",
  "xoxp-demo-secret",
  "zapier-path-token-should-be-redacted-1",
] as const

// deep enough that every page showing its paths has to wrap them on a phone
const ACME = path.join("clients", "acme-corporation-holdings", "engineering", "acme")

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

// What carries this machine's own identity into a process (its Claude login dir, tokens, git config, and the hook's own variables): the sandbox never inherits these, and a test that puts the sandbox's env on its own process must drop them too.
export const UNSEALED = [
  "CLAUDE_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_CONFIG_GLOBAL",
  "INSCOPE_BASE_CCD",
  "INSCOPE_CCD",
  "SLACK_MCP_XOXP_TOKEN",
] as const

// The sealed environment every process touching the sandbox runs with: nothing from the developer's own logins can leak in.
const sealedEnv = (root: string): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  for (const key of UNSEALED) delete env[key]
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

// Bun.write creates the parent directories itself
const write = async (file: string, content: string, mode?: number) => {
  await Bun.write(file, content)
  if (mode) fs.chmodSync(file, mode)
}

export const seedSandbox = async (dir?: string): Promise<Sandbox> => {
  const target = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "inscope-dashboard-"))
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  // realpath: macOS temp dirs resolve through /private, and inscope compares resolved paths
  const root = fs.realpathSync(target)
  const home = path.join(root, "home")
  const env = sealedEnv(root)

  await write(path.join(root, "bin", "gh"), GH, 0o755)
  await write(path.join(root, "bin", "claude"), CLAUDE, 0o755)
  await write(path.join(root, "bin", "security"), SECURITY, 0o755)
  fs.mkdirSync(path.join(root, "gh"), { recursive: true })
  await write(
    path.join(root, "skills", "readme-audit", "SKILL.md"),
    "---\nname: readme-audit\ndescription: Audit a README.\n---\n",
  )

  for (const ws of ["personal", "work", ACME]) {
    fs.mkdirSync(path.join(home, ws), { recursive: true })
    Bun.spawnSync(["git", "init", "-q"], { cwd: path.join(home, ws), env })
  }

  await write(
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
            path: `~/${ACME}`,
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

  const applied = Bun.spawnSync(["bun", CLI, "apply"], { cwd: home, env })
  if (applied.exitCode !== 0)
    throw new Error(`inscope apply failed in the sandbox:\n${applied.stderr.toString()}`)

  // the work login is signed in: Claude leaves its state file in the login dir
  await write(path.join(home, "work", ".inscope", ".claude.json"), '{"oauthAccount":{}}\n')

  // drift work/.mcp.json by hand: a changed URL, plus two servers of the user's own that carry credentials in every shape the redaction covers
  const mcpFile = path.join(home, "work", ".mcp.json")
  const mcp = await Bun.file(mcpFile).json()
  mcp.mcpServers["linear-work"].url = "https://mcp.linear.app/sse-old"
  mcp.mcpServers.mine = {
    command: "npx",
    args: [
      "-y",
      "my-mcp",
      "--api-key",
      "sk-should-be-redacted",
      "postgresql://user:pg-pass-should-be-redacted@localhost/db",
      "--header",
      "Authorization: Bearer header-bearer-should-be-redacted",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN=docker-env-should-be-redacted",
      "--connectionString",
      "Server=db;Password=conn-should-be-redacted",
      "https://mcp.example.com/cb#access_token=fragment-should-be-redacted",
      "--header",
      "authorization: token lower-token-should-be-redacted",
      "--config",
      '{"apiKey":"json-in-string-should-be-redacted","region":"eu"}',
      "-H",
      "X-API-Key:nospace-should-be-redacted",
      "--env=DB_PASSWORD=inline-env-should-be-redacted",
      "-H",
      "Cookie: a=1; session=cookie-two-should-be-redacted",
      "postgresql://user:x@at-sign-pass-should-be-redacted@db.example/x",
      // quoted values, as 21st.dev's magic server documents its key, and a bare token its prefix gives away
      "@21st-dev/magic@latest",
      'API_KEY="quoted-key-should-be-redacted"',
      'DB_URL="Server=db;Password=quoted-conn-should-be-redacted"',
      "--password='single-quoted-should-be-redacted'",
      "-H",
      'X-Api-Key: "quoted-header-should-be-redacted"',
      VENDOR_TOKEN,
      // a whole command in one argument, and a count that only looks like a credential
      "-c",
      "npx -y @acme/mcp --api-key flag-in-string-should-be-redacted",
      "--max-tokens",
      "4096",
    ],
    env: {
      MY_API_KEY: "sk-should-be-redacted",
      MY_TOKEN: "${MY_TOKEN:-default-token-should-be-redacted}",
    },
  }
  // what is not a credential stays readable: a server named like one, its client id and port
  mcp.mcpServers.keycloak = {
    type: "http",
    url: "https://sso.example.com/mcp",
    oauth: { callbackPort: 33418, clientId: "dashboard-client" },
  }
  mcp.mcpServers.remote = {
    type: "http",
    url: "https://mcp.example.com/sse?token=query-token-should-be-redacted",
    headers: { Authorization: "Bearer bearer-should-be-redacted" },
    headersHelper: `echo '{"Authorization":"Bearer helper-bearer-should-be-redacted"}'`,
  }
  // a header helper that is one shell string, a credential flag inside its quotes, after a package named like an auth scheme
  mcp.mcpServers.scripted = {
    type: "http",
    url: "https://mcp.example.com/scripted",
    headersHelper: 'sh -c "npx -y @acme/token --api-key quoted-command-should-be-redacted"',
  }
  // a hosted server whose token is a segment of the URL's path
  mcp.mcpServers.zapier = {
    type: "http",
    url: "https://mcp.zapier.com/api/mcp/s/zapier-path-token-should-be-redacted-1/mcp",
  }
  await write(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`)

  // acme's git include, edited by hand to rewrite GitHub URLs through a token and to answer a host's credential prompts with a shell helper
  const acmeInclude = path.join(home, ".config", "inscope", "git", "acme.gitconfig")
  await Bun.write(
    acmeInclude,
    `${await Bun.file(acmeInclude).text()}[url "https://x-access-token:gitconfig-token-should-be-redacted@github.com/"]
\tinsteadOf = https://github.com/
[credential "https://bitbucket.org"]
\thelper = "!f() { echo username=x-token-auth; echo password=helper-password-should-be-redacted; }; f"
`,
  )

  // acme's .mcp.json was never written (or was deleted)
  fs.rmSync(path.join(home, ACME, ".mcp.json"), { force: true })

  // an inscope link no workspace declares any more, and a skill folder of the user's own
  const workSkills = path.join(home, "work", ".inscope", "skills")
  const orphan = path.join(home, ".config", "inscope", "skills-cache", "local", "old-notes")
  await write(path.join(orphan, "SKILL.md"), "---\nname: old-notes\ndescription: Old notes.\n---\n")
  fs.symlinkSync(orphan, path.join(workSkills, "old-notes"))
  await write(
    path.join(workSkills, "my-notes", "SKILL.md"),
    "---\nname: my-notes\ndescription: Mine.\n---\n",
  )

  // a git skill's cache folder is named after its URL, token included: one left linked after its skill left the config
  const staleGit = path.join(
    home,
    ".config",
    "inscope",
    "skills-cache",
    "git",
    "x-access-token-stale-skill-token-should-be-redacted-git.example.com-org-old-skills",
  )
  await write(path.join(staleGit, "SKILL.md"), "---\nname: old-private\ndescription: Old.\n---\n")
  fs.symlinkSync(staleGit, path.join(workSkills, "old-private"))

  // and acme declares two, after apply so nothing clones them: one from a URL carrying a token, whose source and cache folder must both reach the pages withheld, and a plain one, which stays readable
  const configFile = path.join(home, ".config", "inscope", "inscope.json")
  const config = await Bun.file(configFile).json()
  config.workspaces[2].skills = [
    "https://git.example.com/org/plain-skills.git",
    "https://x-access-token:skill-url-token-should-be-redacted@git.example.com/org/private-skills.git",
  ]
  await write(configFile, `${JSON.stringify(config, null, 2)}\n`)

  return { root, home, env }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--dir")
  const { env } = await seedSandbox(flag === -1 ? undefined : process.argv[flag + 1])
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
