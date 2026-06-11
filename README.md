# Inscope

**Per-workspace identity for [Claude Code](https://claude.com/claude-code): scope MCP servers, GitHub auth, and git commit identity to the directory you are in.**

[![Twitter](https://img.shields.io/twitter/follow/nrjdalal_dev?label=%40nrjdalal_dev)](https://twitter.com/nrjdalal_dev)
[![npm](https://img.shields.io/npm/v/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![downloads](https://img.shields.io/npm/dt/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![stars](https://img.shields.io/github/stars/nrjdalal/inscope?color=blue)](https://github.com/nrjdalal/inscope)

📖 **The why behind the design:** [Race-Free Identity in Claude Code](https://zerostarter.dev/blog/mcp-per-workspace)

> #### `cd` into a project and you are the right person: the right GitHub token, the right MCP servers, the right git commit email, all resolved live from `$PWD`. No toggles, no profile switching, and it holds up with several Claude Code sessions open at once.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/demo.gif" alt="inscope demo: interactive add, list, and doctor" width="900" />
</p>

Concurrent sessions in different projects should never bleed work and personal accounts into each other. You describe each workspace once; `inscope` owns the moving parts and keeps them in sync:

- a `.mcp.json` at each workspace root, with uniquely named servers
- a single zsh `chpwd` hook that resolves the right tokens from `$PWD`
- git `includeIf` rules so commits get the right email per path

Nothing sensitive is written to disk. GitHub tokens come from the `gh` keyring and Slack tokens from the macOS Keychain, resolved live by the hook.

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

# map a workspace — inscope prompts for the gh account, git identity, and servers
inscope add ~/acme
inscope add ~/personal

# edit a workspace interactively
inscope edit acme

# list what is configured, and verify everything resolves
inscope list
inscope doctor

# remove a workspace (asks you to type the label to confirm)
inscope rm acme
```

`cd ~/acme/api` and you are the work account, with work MCP servers and your work commit email. `cd ~/personal/blog` and you are you.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/demo-switch.gif" alt="inscope switching git identity and tokens on cd" width="900" />
</p>

---

## ✨ Features

- 🪪 Per-directory identity: GitHub token, git commit email, and MCP servers scoped to `$PWD`
- 🧵 Race-free across concurrent shells and Claude Code sessions, with no global toggles
- 🔐 No secrets on disk: GitHub tokens from the `gh` keyring, Slack tokens from the macOS Keychain
- 🤖 One `.mcp.json` per workspace with uniquely named servers — GitHub plus OAuth connectors for Atlassian, Canva, ClickUp, HubSpot, Intercom, Linear, monday, Notion, Plane, Sentry, Slack, Stripe, Vercel and Webflow
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

Prerequisite: sign each GitHub account into `gh` once with `gh auth login` (that's gh's own command, not inscope). inscope reads tokens from the accounts you've signed in.

```sh
# set up the config + hook, and source it from ~/.zshrc
inscope init

# map a workspace — inscope walks you through the gh account, git identity, and servers
inscope add ~/acme
inscope add ~/personal

# reload your shell, then verify
source ~/.zshrc
inscope doctor
```

Launch `claude` from inside a mapped directory (or relaunch) to pick up the identity. No toggles, and it holds up with several terminals open at once.

Prefer flags or CI? Every prompt has a flag, and `-y` skips them all:

```sh
inscope add ~/acme --gh <account> --email you@work.com --servers github,linear -y
```

---

## 🔧 Commands

```
inscope init           Create the config, generate the hook, source it from ~/.zshrc
inscope add [path]     Map a directory to a GitHub account, git email, and MCP servers
inscope edit [path]    Edit a workspace interactively, then re-apply
inscope rm [path]      Remove a workspace mapping (alias: remove)
inscope list           List configured workspaces (alias: ls)
inscope apply          Regenerate the hook, git includes, and .mcp.json (alias: sync)
inscope doctor         Verify tokens, identities, and the hook resolve correctly

-v, --version          Display version
-h, --help             Display help
```

Run any command with `-h` for its options.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/demo-manage.gif" alt="inscope edit and rm with type-to-confirm" width="900" />
</p>

### `inscope add`

Run it bare and it walks you through everything: pick the GitHub account from your signed-in `gh` accounts, accept your global git identity or set a per-workspace one, and toggle which MCP servers to enable. Pass any flag to skip its prompt, or `-y` to take the defaults non-interactively (for scripts and CI).

```
  --gh <account>        gh account whose token this workspace uses
  --email <email>       git commit email (omit to inherit your global identity)
  --git-name <name>     git commit author name (omit to inherit global)
  --label <name>        workspace name; defaults to the directory basename
  --servers <list>      comma-separated, any of: github, atlassian, canva,
                        clickup, hubspot, intercom, linear, monday, notion,
                        plane, sentry, slack, stripe, vercel, webflow
                        (default: github)
  --slack-keychain <s>  keychain service for the Slack token
                        (default: SLACK_MCP_XOXP_TOKEN_<LABEL> when slack is on)
  --slack-message       allow the Slack MCP server to post messages
  --seed-slack          prompt for the Slack token and store it in the keychain
  -y, --yes             accept defaults, skip all prompts (non-interactive)
```

---

## 🧩 What It Manages

| Surface      | Location                                                            |
| ------------ | ------------------------------------------------------------------- |
| Config       | `~/.config/inscope/inscope.json`                                    |
| chpwd hook   | `~/.config/inscope/inscope.zsh`                                     |
| MCP servers  | `<workspace>/.mcp.json`                                             |
| Git identity | `~/.gitconfig` includeIf + `~/.config/inscope/git/<name>.gitconfig` |

`inscope` only touches the blocks it owns; your other `.zshrc`, `.gitconfig` and `.mcp.json` content is left alone. Edit `inscope.json` by hand if you like, then run `inscope apply`.

---

## 🤖 MCP Servers

Each enabled server is written into the workspace `.mcp.json` with a name suffixed by the workspace label (for example `github-acme`), so servers from different workspaces never collide.

| Server      | Transport | Auth                                           |
| ----------- | --------- | ---------------------------------------------- |
| `github`    | http      | `GITHUB_TOKEN` from the active `gh` account    |
| `atlassian` | http      | OAuth (Jira / Confluence)                      |
| `canva`     | http      | OAuth                                          |
| `clickup`   | http      | OAuth                                          |
| `hubspot`   | http      | OAuth                                          |
| `intercom`  | http      | OAuth                                          |
| `linear`    | http      | OAuth                                          |
| `monday`    | http      | OAuth                                          |
| `notion`    | http      | OAuth                                          |
| `plane`     | http      | OAuth                                          |
| `sentry`    | http      | OAuth                                          |
| `slack`     | stdio     | `SLACK_MCP_XOXP_TOKEN` from the macOS Keychain |
| `stripe`    | http      | OAuth                                          |
| `vercel`    | http      | OAuth                                          |
| `webflow`   | http      | OAuth                                          |

Slack is opt-in. Enable it with `--servers ...,slack`, then store the token once:

```sh
inscope add ~/acme --gh neeraj-acme-org --servers github,slack --seed-slack
```

`--seed-slack` prompts for the `xoxp` token and writes it to the Keychain. Pass `--slack-message` to allow the Slack MCP server to post messages.

You need a Slack app with a user OAuth (`xoxp`) token first. If you don't have one, follow the [slack-mcp-server authentication guide](https://github.com/korotovsky/slack-mcp-server/blob/HEAD/docs/01-authentication-setup.md#option-2-using-slack_mcp_xoxp_token-user-oauth). inscope points you there during `add` when Slack is enabled.

---

## 📋 Config File

The source of truth is `~/.config/inscope/inscope.json`:

```jsonc
{
  "version": 1,
  "workspaces": [
    {
      "name": "acme",
      "path": "~/acme",
      "gh": "neeraj-acme-org",
      "git": { "email": "neeraj@acme.org" },
      "servers": {
        "github": true,
        "linear": true,
        "slack": {
          "keychain": "SLACK_MCP_XOXP_TOKEN_ACME",
          "addMessageTool": false,
        },
        // every other server (atlassian, canva, … webflow) defaults to false
      },
    },
  ],
}
```

Edit it directly, then run `inscope apply` to regenerate the hook, git includes, and every `.mcp.json`. `inscope doctor` will tell you if anything no longer resolves.

---

## 🤝 Contributing

Issues and pull requests are welcome. Run the tests with `bun test` and the type checks with `bun run typecheck` before opening a PR.

---

## License

[MIT](./LICENSE) © [Neeraj Dalal](https://nrjdalal.com)
