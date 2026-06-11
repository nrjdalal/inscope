# Inscope

**Per-workspace identity for [Claude Code](https://claude.com/claude-code): scope MCP servers, GitHub auth, and git commit identity to the directory you are in.**

[![Twitter](https://img.shields.io/twitter/follow/nrjdalal_dev?label=%40nrjdalal_dev)](https://twitter.com/nrjdalal_dev)
[![npm](https://img.shields.io/npm/v/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![downloads](https://img.shields.io/npm/dt/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![stars](https://img.shields.io/github/stars/nrjdalal/inscope?color=blue)](https://github.com/nrjdalal/inscope)

> #### `cd` into a project and you are the right person: the right GitHub token, the right MCP servers, the right git commit email, all resolved live from `$PWD`. No toggles, no profile switching, and it holds up with several Claude Code sessions open at once.

Concurrent sessions in different projects should never bleed work and personal accounts into each other. You describe each workspace once; `inscope` owns the moving parts and keeps them in sync:

- a `.mcp.json` at each workspace root, with uniquely named servers
- a single zsh `chpwd` hook that resolves the right tokens from `$PWD`
- git `includeIf` rules so commits get the right email per path

Nothing sensitive is written to disk. GitHub tokens come from the `gh` keyring and Slack tokens from the macOS Keychain, resolved live by the hook.

> Background and the why behind the design: [Race-Free Identity in Claude Code](https://zerostarter.dev/blog/mcp-per-workspace).

---

### Table of Contents

- [Some Examples](#-some-examples)
- [Features](#-features)
- [Requirements](#-requirements)
- [Quick Usage](#-quick-usage)
- [Commands](#-commands)
- [What It Manages](#-what-it-manages)
- [MCP Servers](#-mcp-servers)
- [Config File](#-config-file)
- [Contributing](#-contributing)

---

## 📖 Some Examples

```sh
# set up the config + hook, and source it from ~/.zshrc
inscope init

# map a work directory: work gh account, work email, work + slack servers
inscope add ~/acme --gh acme --email you@acme.com --servers github,linear,notion,slack

# map a personal directory: just your gh account and personal email
inscope add ~/nrjdalal --gh nrjdalal --email you@personal.dev

# list what is configured
inscope list

# verify tokens, identities, and the hook all resolve
inscope doctor

# regenerate everything after editing the config by hand
inscope apply

# remove a workspace mapping
inscope rm ~/acme
```

`cd ~/acme/api` and you are the work account, with work MCP servers and your work commit email. `cd ~/nrjdalal/blog` and you are you.

---

## ✨ Features

- 🪪 Per-directory identity: GitHub token, git commit email, and MCP servers scoped to `$PWD`
- 🧵 Race-free across concurrent shells and Claude Code sessions, with no global toggles
- 🔐 No secrets on disk: GitHub tokens from the `gh` keyring, Slack tokens from the macOS Keychain
- 🤖 Generates a `.mcp.json` per workspace with uniquely named GitHub, Linear, Notion and Slack servers
- ✉️ Git `includeIf` rules so every commit lands with the right author email per path
- 🪝 A single zsh `chpwd` hook does all the resolution; nothing else touches your shell
- 🩺 `inscope doctor` verifies tokens, identities, and the hook before you trust them
- ♻️ Idempotent and surgical: only the managed blocks in `.zshrc`, `.gitconfig` and `.mcp.json` are touched

---

## 🧰 Requirements

macOS, zsh, [`gh`](https://cli.github.com), and [Claude Code](https://claude.com/claude-code).

---

## 🚀 Quick Usage

Install globally (the CLI manages your shell hook, so a global install is expected):

```sh
npm i -g inscope
```

Then walk through the setup once:

```sh
# 1. set up the config + hook, and source it from ~/.zshrc
inscope init

# 2. sign each GitHub account into gh (once per account)
gh auth login

# 3. map your workspaces
inscope add ~/acme     --gh acme     --email you@acme.com --servers github,linear,notion,slack
inscope add ~/nrjdalal --gh nrjdalal --email you@personal.dev

# 4. reload your shell, then verify
source ~/.zshrc
inscope doctor
```

Launch `claude` from inside a mapped directory (or relaunch) to pick up the identity. No toggles, and it holds up with several terminals open at once.

---

## 🔧 Commands

```
inscope init           Create the config, generate the hook, source it from ~/.zshrc
inscope add <path>     Map a directory to a GitHub account, git email, and MCP servers
inscope rm <path>      Remove a workspace mapping (alias: remove)
inscope list           List configured workspaces (alias: ls)
inscope apply          Regenerate the hook, git includes, and .mcp.json (alias: sync)
inscope doctor         Verify tokens, identities, and the hook resolve correctly

-v, --version          Display version
-h, --help             Display help
```

Run any command with `-h` for its options.

### `inscope add` options

```
    --gh <account>        gh account whose token this workspace uses
    --email <email>       git commit email for this workspace
    --git-name <name>     git commit author name (optional)
    --label <name>        workspace name; defaults to the directory basename
    --servers <list>      comma-separated: github,linear,notion,slack
                          (default: github,linear,notion)
    --slack-keychain <s>  keychain service for the Slack token
                          (default: slack-<label>-mcp-xoxp when slack is on)
    --slack-message       allow the Slack MCP server to post messages
    --seed-slack          prompt for the Slack token and store it in the keychain
```

---

## 🧩 What It Manages

| Surface      | Location                                                    |
| ------------ | ----------------------------------------------------------- |
| Config       | `~/.config/claude/workspaces.json`                          |
| chpwd hook   | `~/.config/claude/mcp-tokens.zsh`                           |
| MCP servers  | `<workspace>/.mcp.json`                                     |
| Git identity | `~/.gitconfig` includeIf + `~/.config/git/<name>.gitconfig` |

`inscope` only touches the blocks it owns; your other `.zshrc`, `.gitconfig` and `.mcp.json` content is left alone. Edit `workspaces.json` by hand if you like, then run `inscope apply`.

---

## 🤖 MCP Servers

Each enabled server is written into the workspace `.mcp.json` with a name suffixed by the workspace label (for example `github-acme`), so servers from different workspaces never collide.

| Server   | Transport | Token source                                   |
| -------- | --------- | ---------------------------------------------- |
| `github` | http      | `GITHUB_TOKEN` from the active `gh` account    |
| `linear` | http      | OAuth via the Linear MCP endpoint              |
| `notion` | http      | OAuth via the Notion MCP endpoint              |
| `slack`  | stdio     | `SLACK_MCP_XOXP_TOKEN` from the macOS Keychain |

Slack is opt-in. Enable it with `--servers ...,slack`, then store the token once:

```sh
inscope add ~/acme --gh acme --servers github,linear,notion,slack --seed-slack
```

`--seed-slack` prompts for the `xoxp` token and writes it to the Keychain. Pass `--slack-message` to allow the Slack MCP server to post messages.

---

## 📋 Config File

The source of truth is `~/.config/claude/workspaces.json`:

```jsonc
{
  "version": 1,
  "workspaces": [
    {
      "name": "acme",
      "path": "~/acme",
      "gh": "acme",
      "git": { "email": "you@acme.com" },
      "servers": {
        "github": true,
        "linear": true,
        "notion": true,
        "slack": { "keychain": "slack-acme-mcp-xoxp", "addMessageTool": false }
      }
    }
  ]
}
```

Edit it directly, then run `inscope apply` to regenerate the hook, git includes, and every `.mcp.json`. `inscope doctor` will tell you if anything no longer resolves.

---

## 🤝 Contributing

Issues and pull requests are welcome. Run the tests with `bun test` and the type checks with `bun run typecheck` before opening a PR.

---

## License

[MIT](./LICENSE) © [Neeraj Dalal](https://nrjdalal.com)
