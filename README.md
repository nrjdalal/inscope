# inscope

Per-workspace identity for [Claude Code](https://claude.com/claude-code). Scope
MCP servers, GitHub auth, and git commit identity to the directory you are in,
so concurrent sessions in different projects never bleed work and personal
accounts into each other.

You describe each workspace once; `inscope` owns the moving parts and keeps them
in sync:

- a `.mcp.json` at each workspace root, with uniquely named servers
- a single zsh `chpwd` hook that resolves the right tokens from `$PWD`
- git `includeIf` rules so commits get the right email per path

Nothing sensitive is written to disk. GitHub tokens come from the `gh` keyring
and Slack tokens from the macOS Keychain, resolved live by the hook.

> Background and the why behind the design:
> [Race-Free Identity in Claude Code](https://zerostarter.dev/blog/mcp-per-workspace).

## Requirements

macOS, zsh, [`gh`](https://cli.github.com), and Claude Code.

## Install

```bash
npm i -g inscope
```

## Quickstart

```bash
# 1. set up the config + hook, and source it from ~/.zshrc
inscope init

# 2. sign each GitHub account into gh (once)
gh auth login   # repeat per account

# 3. map your workspaces
inscope add ~/acme     --gh acme     --email you@acme.com --servers github,linear,notion,slack
inscope add ~/nrjdalal --gh nrjdalal --email you@personal.dev

# 4. reload your shell, then verify
source ~/.zshrc
inscope doctor
```

`cd ~/acme/api` and you are the work account, with work MCP servers and your
work commit email. `cd ~/nrjdalal/blog` and you are you. No toggles, and it
holds up with several terminals open at once.

## Commands

| Command        | What it does                                                         |
| -------------- | -------------------------------------------------------------------- |
| `inscope init`   | create the config, generate the hook, source it from `~/.zshrc`      |
| `inscope add`    | map a directory to a gh account, git email, and MCP servers          |
| `inscope rm`     | remove a workspace mapping                                           |
| `inscope list`   | list configured workspaces                                           |
| `inscope apply`  | regenerate the hook, git includes, and every `.mcp.json` from config |
| `inscope doctor` | verify tokens, identities, and the hook resolve correctly            |

Run any command with `-h` for its options.

## What it manages

| Surface      | Location                                                    |
| ------------ | ----------------------------------------------------------- |
| Config       | `~/.config/claude/workspaces.json`                          |
| chpwd hook   | `~/.config/claude/mcp-tokens.zsh`                           |
| MCP servers  | `<workspace>/.mcp.json`                                     |
| Git identity | `~/.gitconfig` includeIf + `~/.config/git/<name>.gitconfig` |

Edit `workspaces.json` by hand if you like, then run `inscope apply`. It only
touches the blocks it owns; your other `.zshrc`, `.gitconfig`, and `.mcp.json`
content is left alone.

## License

MIT
