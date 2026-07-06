# Inscope

**Per-workspace identity for [Claude Code](https://claude.com/claude-code): scope MCP servers, GitHub auth, and git commit identity to the directory you are in.**

[![Twitter](https://img.shields.io/twitter/follow/nrjdalal_dev?label=%40nrjdalal_dev)](https://twitter.com/nrjdalal_dev)
[![npm](https://img.shields.io/npm/v/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![downloads](https://img.shields.io/npm/dt/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![stars](https://img.shields.io/github/stars/nrjdalal/inscope?color=blue)](https://github.com/nrjdalal/inscope)

🔐 `Zero dependencies` / `Nothing sensitive on disk` / `One zsh hook` / `Race-free across concurrent sessions`

📖 **The why behind the design:** [Race-Free Identity in Claude Code](https://zerostarter.dev/blog/mcp-per-workspace), aka multiple gh, linear, notion, slack and other accounts.

> #### `cd` into a project and you are the right person: the right GitHub token, the right MCP servers, the right git commit email, all resolved live from `$PWD`. No toggles, no profile switching, and it holds up with several Claude Code sessions open at once.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/demo.gif" alt="inscope flips git identity and the GitHub token per directory on cd" width="900" />
</p>

You describe each workspace once; `inscope` owns the moving parts and keeps them in sync from a single source of truth:

- a `.mcp.json` at each workspace root, with uniquely named servers
- one zsh `chpwd` hook that resolves the right tokens from `$PWD`
- git `includeIf` rules so commits land with the right author email per path

Nothing sensitive is written to disk: GitHub tokens come from the `gh` keyring and Slack tokens from the macOS Keychain, resolved live by the hook. It is race-free across concurrent shells and Claude Code sessions, with no global toggles, and idempotent: only the blocks it owns inside `.zshrc`, `.gitconfig`, and `.mcp.json` are ever touched.

---

### Table of Contents

- [Features](#-features)
- [Quick Usage](#-quick-usage)
- [Requirements](#-requirements)
- [Commands](#-commands)
  - [`inscope init`](#inscope-init)
  - [`inscope add`](#inscope-add)
  - [`inscope edit`](#inscope-edit)
  - [`inscope rm`](#inscope-rm)
  - [`inscope list`](#inscope-list)
  - [`inscope diff`](#inscope-diff)
  - [`inscope apply`](#inscope-apply)
  - [`inscope doctor`](#inscope-doctor)
- [What It Manages](#-what-it-manages)
- [Claude Code subscriptions: config dir per workspace](#-claude-code-subscriptions-config-dir-per-workspace)
- [MCP Servers](#-mcp-servers)
- [Config File](#-config-file)
- [Install Globally (Optional)](#-install-globally-optional)
- [Contributing](#-contributing)
- [More Tools](#-more-tools)

---

## ✨ Features

- 🪪 Per-directory identity: GitHub token, git commit email, and MCP servers scoped to `$PWD`
- 🎫 Per-directory Claude Code config dir: point work and personal directories at different `~/.claude*` profiles (and different subscriptions) with no wrapper functions
- 🧵 Race-free across concurrent shells and Claude Code sessions, with no global toggles
- 🔐 No secrets on disk: GitHub tokens from the `gh` keyring, Slack tokens from the macOS Keychain
- 🤖 One `.mcp.json` per workspace with uniquely named servers: GitHub plus OAuth connectors for Atlassian, Canva, ClickUp, HubSpot, Intercom, Linear, monday, Notion, Plane, Sentry, Slack, Stripe, Vercel, and Webflow
- ✉️ Git `includeIf` rules so every commit lands with the right author email per path
- 🪝 A single zsh `chpwd` hook does all the resolution; nothing else touches your shell
- 🩺 `inscope doctor` verifies tokens, identities, and the hook before you trust them
- ♻️ Idempotent and surgical: only the managed blocks in `.zshrc`, `.gitconfig`, and `.mcp.json` are touched

---

## 🚀 Quick Usage

No install required, just prefix any command with `npx`:

```sh
# set up the config + hook, and source it from ~/.zshrc
npx inscope init

# map a workspace - inscope walks you through gh account, git identity, and servers
npx inscope add ~/acme
npx inscope add ~/personal

# reload your shell, then verify
source ~/.zshrc
npx inscope doctor
```

Scoping GitHub accounts? Sign each one into `gh` once with `gh auth login` (that is gh's own command, not inscope); inscope reads tokens from the accounts you have signed in.

`cd ~/acme/api` and you are the work account, with work MCP servers and your work commit email. `cd ~/personal/blog` and you are you. Launch `claude` from inside a mapped directory (or relaunch) to pick up the identity.

Prefer flags or CI? Every prompt has a flag, and `-y` takes the defaults non-interactively:

```sh
npx inscope add ~/acme --gh <account> --email you@work.com --servers github,linear -y
```

Running these a lot? Drop the `npx` with a [global install](#-install-globally-optional).

---

## 🧰 Requirements

macOS, zsh, and [Claude Code](https://claude.com/claude-code).

[`gh`](https://cli.github.com) is needed only for workspaces that scope a GitHub account.

---

## 🔧 Commands

```
inscope init        Create the config, generate the hook, source it from ~/.zshrc
inscope add  [path] Map a directory to a GitHub account, git email, and MCP servers
inscope edit [path] Edit a workspace interactively, then re-apply
inscope rm   [path] Remove a workspace mapping (alias: remove)
inscope list        List configured workspaces (alias: ls)
inscope diff        Preview what apply would change; --adopt pulls on-disk extras back
inscope apply       Regenerate the hook, git includes, and .mcp.json (alias: sync)
inscope doctor      Verify tokens, identities, and the hook resolve correctly

-v, --version       Display version
-h, --help          Display help
```

Run any command with `-h` for its full options.

### `inscope init`

Create the config, generate the chpwd hook, and add a source line to `~/.zshrc`. Safe to run again; it never overwrites your config.

Pass `--wrap-claude` to emit the optional [`claude()` launch wrapper](#-claude-code-subscriptions-config-dir-per-workspace) into the hook.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/init.gif" alt="inscope init creating the config and hook" width="900" />
</p>

### `inscope add`

Map a directory. Run it bare and it walks you through everything: pick the GitHub account from your signed-in `gh` accounts, accept your global git identity or set a per-workspace one, and toggle which MCP servers to enable. Enabling Slack adds a keychain prompt and a Yes/No for posting messages. Pass any flag to skip its prompt, or `-y` to take the defaults non-interactively (for scripts and CI).

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/add.gif" alt="inscope add: gh picker, git identity, server multiselect, the Slack package picker, and the Slack prompts" width="900" />
</p>

```
  --gh <account>        gh account whose token this workspace uses
  --claude <profile>    Claude Code config profile for this subtree: sets
                        CLAUDE_CONFIG_DIR to ~/.claude-<profile> (use "claude" or
                        omit for the base ~/.claude, where unmapped dirs resolve)
  --email <email>       git commit email (omit to inherit your global identity)
  --git-name <name>     git commit author name (omit to inherit global)
  --label <name>        workspace name; defaults to the directory basename
  --servers <list>      comma-separated, any of: github, atlassian, canva,
                        clickup, hubspot, intercom, linear, monday, notion,
                        plane, sentry, slack, stripe, vercel, webflow
                        (default: github)
  --slack-keychain <s>  keychain service for the Slack token
                        (default: SLACK_MCP_XOXP_TOKEN_<LABEL> when slack is on)
  --slack-package <p>   Slack MCP server package: slack-mcp-server (default,
                        pinned) or @nrjdalal/slack-mcp-server (kept on latest)
  --slack-message       allow the Slack MCP server to post messages
  --seed-slack          prompt for the Slack token and store it in the keychain
  -y, --yes             accept defaults, skip all prompts (non-interactive)
```

### `inscope edit`

Step through a workspace's prompts pre-filled with its current values (pick it, or pass its path/label), then inscope re-applies on save.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/edit.gif" alt="inscope edit: prompts pre-filled with the workspace's current values" width="900" />
</p>

### `inscope rm`

Remove a workspace mapping (alias `remove`). Drops its git include and the MCP servers inscope manages; your keychain entries and gh accounts are left untouched. Asks you to type the label to confirm, or pass `-y` to skip the prompt.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/rm.gif" alt="inscope rm with a type-the-label confirm" width="900" />
</p>

### `inscope list`

List the configured workspaces with their path, gh account, git email, and enabled servers (alias `ls`). Run `inscope doctor` to verify they actually resolve.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/list.gif" alt="inscope list showing the configured workspaces" width="900" />
</p>

### `inscope diff`

Preview exactly what `apply` would write: a colored diff of the hook, git includes, and each `.mcp.json` against your config. `--adopt` pulls config-expressible on-disk settings (a Slack add-message tool or package, a custom server URL) back into the config, so the next apply keeps them instead of dropping them. `--exit-code` exits non-zero when anything is out of sync, so it works as a CI or pre-commit gate.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/diff.gif" alt="inscope diff: colored drift, then --adopt back-syncs an on-disk setting into the config" width="900" />
</p>

### `inscope apply`

Regenerate the hook, git includes, and every `.mcp.json` from the config (alias `sync`). Idempotent and surgical: only the managed blocks are touched, and writes are atomic. Run it any time you edit `inscope.json` by hand.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/apply.gif" alt="inscope apply regenerating the hook, git includes, and each .mcp.json" width="900" />
</p>

### `inscope doctor`

Verify that tokens, identities, the hook, and each `.mcp.json` resolve correctly. Exits non-zero if anything fails, so it doubles as a health gate.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/doctor.gif" alt="inscope doctor verifying tokens, identities, and the hook" width="900" />
</p>

---

## 🧩 What It Manages

| Surface      | Location                                                            |
| ------------ | ------------------------------------------------------------------- |
| Config       | `~/.config/inscope/inscope.json`                                    |
| chpwd hook   | `~/.config/inscope/inscope.zsh`                                     |
| MCP servers  | `<workspace>/.mcp.json`                                             |
| Git identity | `~/.gitconfig` includeIf + `~/.config/inscope/git/<name>.gitconfig` |

`inscope` only touches the blocks it owns; your other `.zshrc`, `.gitconfig`, and `.mcp.json` content is left alone. Edit `inscope.json` by hand if you like, then run `inscope apply`.

---

## 🎫 Claude Code subscriptions: config dir per workspace

Claude Code reads `CLAUDE_CONFIG_DIR` to decide which config dir it runs from, and each dir carries its own login (and therefore its own subscription). `CLAUDE_CONFIG_DIR` is read **once, at launch**, so instead of juggling wrapper functions like `claude` vs `wlaude`, inscope generates a single `claude()` wrapper that resolves the config dir from `$PWD` at the moment you launch: `cd` into a workspace and the next `claude` runs on the right subscription.

You set a per-workspace `claude` **profile**; inscope maps it to a config dir:

- the reserved name `claude` means the base `~/.claude` (Claude Code's own default)
- any other name `<x>` means the sibling dir `~/.claude-<x>` (for example `acme` -> `~/.claude-acme`)

Set it with `inscope add --claude <profile>` (or `inscope edit`). Setting a profile on any workspace makes inscope emit the `claude()` wrapper into the generated hook (just as enabling a server writes a `.mcp.json`); the token `chpwd` hook is left untouched. The wrapper resolves like this:

```zsh
claude() {
  local dir="$HOME/.claude"                     # base ~/.claude is the global home
  case "${PWD}/" in
    "$HOME/acme/"*) dir="$HOME/.claude-acme" ;;  # a workspace with claude: acme
  esac
  CLAUDE_CONFIG_DIR="$dir" command claude "$@"   # set for this launch only
}
```

So the base `~/.claude` is where every unmapped directory (and any workspace without a profile) resolves; only a workspace that names a profile is pointed elsewhere. Your everyday login stays put and you opt specific subtrees into their own config dir. `CLAUDE_CONFIG_DIR` is never left set in your shell; it applies only to the `claude` you launch.

If no workspace names a profile (and `wrapClaude` is unset), inscope emits no wrapper at all, so nothing changes for existing setups. Migrating from a wrapper is a one-liner that preserves the login: `mv ~/.claude-max ~/.claude-acme`, then point that work directory at the `acme` profile. `inscope doctor` warns if a profile's config dir does not exist yet (launch `claude` there once to sign in).

> One caveat: because the dir is resolved when the wrapper runs, this only applies to launches through the shell's `claude` function. Launching Claude from an IDE or GUI (which does not go through the wrapper) uses the base `~/.claude`.

### Launch flags (`wrapClaude`)

The same wrapper can carry launch flags. Set `wrapClaude` to run `claude update` before each launch and pass `--dangerously-skip-permissions`:

```jsonc
{
  "version": 1,
  "wrapClaude": true,            // shorthand: claude update + --dangerously-skip-permissions
  "workspaces": [ … ]
}
```

`true` turns both flags on. For finer control use the object form and toggle each flag (an omitted flag is off):

```jsonc
"wrapClaude": { "dangerouslySkipPermissions": true }   // skip-permissions only, no auto-update
```

`wrapClaude` is independent of profiles: set it alone and you get the `claude()` wrapper with just the flags (no config-dir resolution); set both and the flags ride on the same wrapper that resolves the dir. Enable it during setup with `inscope init --wrap-claude`. The `claude()` function lives in the managed `inscope.zsh`, regenerated on every `inscope apply`. With neither a profile nor `wrapClaude`, no wrapper is emitted, leaving any `claude()` you define yourself untouched.

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

Slack is opt-in. Enable it during `add` (shown above), or with flags, then store the token once:

```sh
npx inscope add ~/acme --gh neeraj-acme-org --servers github,slack --seed-slack
```

`--seed-slack` prompts for the `xoxp` token and writes it to the Keychain. Pass `--slack-message` to allow the Slack MCP server to post messages.

The Slack setup also lets you pick the server package: the original [`slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server) (pinned to a known-good version, the default) or [`@nrjdalal/slack-mcp-server`](https://www.npmjs.com/package/@nrjdalal/slack-mcp-server) (kept on `latest`). Choose it in the prompt, or pass `--slack-package @nrjdalal/slack-mcp-server`.

You need a Slack app with a user OAuth (`xoxp`) token first. If you don't have one, follow the [slack-mcp-server authentication guide](https://github.com/korotovsky/slack-mcp-server/blob/HEAD/docs/01-authentication-setup.md#option-2-using-slack_mcp_xoxp_token-user-oauth). inscope points you there during `add` when Slack is enabled.

---

## 📋 Config File

The source of truth is `~/.config/inscope/inscope.json`:

```jsonc
{
  "version": 1,
  // optional: emit a claude() launch wrapper into the hook (see above)
  "wrapClaude": true,
  "workspaces": [
    {
      "name": "acme",
      "path": "~/acme",
      "gh": "neeraj-acme-org",
      // this subtree gets its own config dir: CLAUDE_CONFIG_DIR -> ~/.claude-acme
      // (omit to stay on the base ~/.claude, where unmapped dirs also resolve)
      "claude": "acme",
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

## 📦 Install Globally (Optional)

Reaching for inscope often? Install it once and drop the `npx`:

```sh
npm i -g inscope
inscope <command> [options]
```

---

## 🤝 Contributing

Issues and pull requests are welcome. Run the tests with `bun test` and the type checks with `bun run typecheck` before opening a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the toolchain and architecture.

---

## 🛠 More Tools

- [gitpick](https://github.com/nrjdalal/gitpick) - clone exactly the files, folders, or branches you need from any repo
- [zerostarter](https://github.com/nrjdalal/zerostarter) - the tooling and practices inscope is built on

More at [github.com/nrjdalal](https://github.com/nrjdalal).

---

## License

[MIT](./LICENSE) © [Neeraj Dalal](https://nrjdalal.com)
