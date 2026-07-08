# Inscope

**Per-workspace identity for [Claude Code](https://claude.com/claude-code): scope the Claude login, MCP servers, GitHub token, and git commit email to the directory you are in.**

[![Twitter](https://img.shields.io/twitter/follow/nrjdalal_dev?label=%40nrjdalal_dev)](https://twitter.com/nrjdalal_dev)
[![npm](https://img.shields.io/npm/v/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![downloads](https://img.shields.io/npm/dt/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![stars](https://img.shields.io/github/stars/nrjdalal/inscope?color=blue)](https://github.com/nrjdalal/inscope)

`cd` into a workspace and inscope makes you the right person for it: your work GitHub account, MCP servers, and commit email in `~/acme`, your personal ones in `~/personal`, and, if you want, each with its own Claude Code login. Everything resolves live from `$PWD` when you launch `claude`, so there are no profiles to switch, no global toggles, and it holds up with several Claude Code sessions open at once.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/demo.gif" alt="inscope flips git identity and the GitHub token per directory on cd" width="900" />
</p>

You describe each workspace once, and inscope keeps the moving parts in sync from that single config. Nothing sensitive is written to disk: GitHub tokens come from the `gh` keyring and Slack tokens from the macOS Keychain, both resolved live by one zsh hook. It only edits the blocks it manages inside `.zshrc`, `.gitconfig`, and `.mcp.json`, so the rest of those files is left alone.

📖 The reasoning behind the design: [Race-Free Identity in Claude Code](https://zerostarter.dev/blog/mcp-per-workspace).

---

### Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
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
- [Isolated Workspaces](#-isolated-workspaces)
- [Skills](#-skills)
- [MCP Servers](#-mcp-servers)
- [Config File](#-config-file)
- [Install Globally](#-install-globally)
- [Contributing](#-contributing)
- [More Tools](#-more-tools)

---

## ✨ Features

- 🪪 **Per-directory identity**: the right GitHub token, git commit email, and MCP servers, all resolved from `$PWD`.
- 🎫 **Isolated Claude logins**: mark a workspace `isolate` and `claude` runs on its own account from a workspace-local `.inscope` dir, picked up automatically when you launch from the directory.
- 🧵 **Race-free**: correct across concurrent shells and Claude Code sessions, with no global toggles.
- 🔐 **Nothing sensitive on disk**: GitHub tokens come from the `gh` keyring, Slack tokens from the macOS Keychain.
- 🤖 **One `.mcp.json` per workspace**: uniquely named servers so nothing collides: GitHub plus OAuth connectors for Atlassian, Canva, ClickUp, HubSpot, Intercom, Linear, monday, Notion, Plane, Sentry, Slack, Stripe, Vercel, and Webflow.
- ✉️ **Git `includeIf` per path**: every commit lands with the right author email.
- 🪝 **One zsh `chpwd` hook** does all the resolving; nothing else touches your shell.
- 🩺 **`inscope doctor`** verifies tokens, identities, and the hook before you trust them.
- ♻️ **Idempotent and surgical**: only the managed blocks in `.zshrc`, `.gitconfig`, and `.mcp.json` are ever touched.

---

## 🚀 Quick Start

No install required. Prefix any command with `npx`:

```sh
# set up the config + hook, and source it from ~/.zshrc
npx inscope init

# map a workspace: inscope walks you through gh account, git identity, and servers
npx inscope add ~/acme
npx inscope add ~/personal

# reload your shell, then verify
source ~/.zshrc
npx inscope doctor
```

To scope GitHub accounts, sign each one into `gh` once with `gh auth login` (that is gh's own command, not inscope's); inscope reads tokens from the accounts you have signed in.

Now `cd ~/acme/api` and you are the work account, with work MCP servers and your work commit email. `cd ~/personal/blog` and you are you. Launch `claude` from inside a mapped directory (or relaunch it) to pick up the identity.

Prefer flags or CI? Every prompt has a flag, and `-y` takes the defaults non-interactively:

```sh
npx inscope add ~/acme --gh <account> --email you@work.com --servers github,linear -y
```

Running these a lot? Drop the `npx` with a [global install](#-install-globally).

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
inscope skill       Manage a workspace's Claude skills (add, list, rm, update)
inscope diff        Preview what apply would change; --adopt pulls on-disk extras back
inscope apply       Regenerate the hook, git includes, .mcp.json, and skill links (alias: sync)
inscope doctor      Verify tokens, identities, and the hook resolve correctly

-v, --version       Display version
-h, --help          Display help
```

Run any command with `-h` for its full options.

### `inscope init`

Create the config, generate the chpwd hook, and add a source line to `~/.zshrc`. Safe to run again; it never overwrites your config.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/init.gif" alt="inscope init creating the config and hook" width="900" />
</p>

### `inscope add`

Map a directory. Run it bare and it walks you through everything: pick the GitHub account from your signed-in `gh` accounts, accept your global git identity or set a per-workspace one, toggle which MCP servers to enable, and choose whether this workspace gets its own Claude login. Enabling Slack adds a package pick, a keychain prompt, and Yes/No prompts for posting messages and storing the token. Pass any flag to skip its prompt, or `-y` to take the defaults non-interactively.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/add.gif" alt="inscope add: gh picker, git identity, server multiselect, the Slack prompts, and the dedicated-login prompt" width="900" />
</p>

```
  --gh <account>        gh account whose token this workspace uses
  --isolate             give this workspace its own Claude login, in a local,
                        gitignored <path>/.inscope config dir
  --email <email>       git commit email (omit to inherit your global identity)
  --git-name <name>     git commit author name (omit to inherit global)
  --label <name>        workspace name; defaults to the directory basename
  --servers <list>      comma-separated, any of: github, atlassian, canva,
                        clickup, hubspot, intercom, linear, monday, notion,
                        plane, sentry, slack, stripe, vercel, webflow
                        (default: github)
  --slack-keychain <s>  keychain service for the Slack token
                        (default: SLACK_MCP_XOXP_TOKEN_<LABEL> when slack is on)
  --slack-package <p>   Slack MCP server package: @nrjdalal/slack-mcp-server
                        (default, kept on latest) or slack-mcp-server (pinned)
  --slack-message       allow the Slack MCP server to post messages
  --seed-slack          prompt for the Slack token and store it in the keychain
  -y, --yes             accept defaults, skip all prompts (non-interactive)
```

### `inscope edit`

Step through a workspace's prompts pre-filled with its current values (pick it, or pass its path/label), then inscope re-applies on save.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/edit.gif" alt="inscope edit: prompts pre-filled with the workspace's current values, here enabling Slack and a dedicated Claude login" width="900" />
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

Regenerate the hook, git includes, every `.mcp.json`, and each workspace's skill links from the config (alias `sync`). Idempotent and surgical: only the managed blocks are touched, and writes are atomic. Run it any time you edit `inscope.json` by hand.

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

| Surface       | Location                                                                             |
| ------------- | ------------------------------------------------------------------------------------ |
| Config        | `~/.config/inscope/inscope.json`                                                     |
| chpwd hook    | `~/.config/inscope/inscope.zsh`                                                      |
| MCP servers   | `<workspace>/.mcp.json`                                                              |
| Git identity  | `~/.gitconfig` includeIf + `~/.config/inscope/git/<name>.gitconfig`                  |
| Claude login  | `<workspace>/.inscope` (isolated workspaces only, gitignored)                        |
| Claude skills | `~/.claude/skills/<name>`, or `<workspace>/.inscope/skills` when isolated (symlinks) |

inscope only touches the blocks it owns; your other `.zshrc`, `.gitconfig`, and `.mcp.json` content is left alone. Edit `inscope.json` by hand if you like, then run `inscope apply`.

---

## 🎫 Isolated Workspaces

By default every directory shares your normal Claude Code login at `~/.claude`. Mark a workspace `isolate` and it runs `claude` on its own login instead, kept in a workspace-local `.inscope` dir, so a client's subscription or a work/personal split stays separate while everything else keeps the shared login.

```sh
npx inscope add ~/acme --isolate   # or toggle it later with inscope edit
```

On the next `apply`, inscope scaffolds `~/acme/.inscope` (gitignored, it holds a login) and the chpwd hook **exports** `CLAUDE_CONFIG_DIR` pointing there whenever `$PWD` is inside the workspace. Exporting the login (rather than wrapping the `claude` command) means any launcher that inherits the shell environment, a terminal, an IDE, or a cmux tab, runs on the right login, and cmux's own session restore keeps working. Sign in once; that login is reused, and `inscope doctor` warns if it is unsigned or tracked by git. A fully shell-less launch (some GUI/agent modes) needs its own env, so it falls back to the shared `~/.claude`.

Because the login is exported, a shell you spawn from _inside_ an isolated subtree inherits it: an unmapped directory reached from that nested shell keeps the isolated login until you `cd` back into a mapped one. That inheritance is what lets cmux restore the right account when it reopens a tab, but under other multiplexers (tmux) or a plain nested shell it means "outside a workspace" can resolve to the last isolated login rather than `~/.claude`.

To skip Claude's permission prompts in isolated logins, set the top-level `bypass: true`. inscope writes `permissions.defaultMode: "bypassPermissions"` into each isolated workspace's own `.inscope/settings.json`, on disk, so every launcher honors it with no launch flag. Your shared `~/.claude` base login is yours to configure; inscope never writes there.

---

## 🎓 Skills

`inscope skill add` clones a skill source once into a shared cache and symlinks it into the workspace's personal Claude skills dir. Because that is personal scope, Claude lists the skill in the `/` menu and loads it in every project you open, under any launcher (a shell, an IDE, or cmux). An isolated workspace keeps its skills private to its own login; a non-isolated one shares `~/.claude/skills` with your other non-isolated workspaces.

```sh
# run from inside the workspace, or pass --workspace <label>
npx inscope skill add owner/repo#skills/readme-audit   # one skill inside a repo
npx inscope skill add owner/repo                        # many skills: pick interactively
npx inscope skill add owner/repo --list                 # preview a repo's skills
npx inscope skill add owner/repo --skill a --skill b    # specific ones (--all for all)
npx inscope skill add owner/repo --name triage          # rename the /command
npx inscope skill add ~/dev/my-skills/deploy            # a local path
npx inscope skill list                                  # what this workspace has
npx inscope skill rm triage                             # drop it
npx inscope skill update                                # pull floating git sources
```

A source is a GitHub `owner/repo` (or a browser `tree`/`blob` URL), a git URL, or a local path, with an optional `#subdir` pointing at the folder that holds `SKILL.md`, and `--ref` to pin a branch, tag, or sha (git sources float on the default branch otherwise). When a repo holds several skills, `add` lists them and lets you pick (interactively, or with `--skill`/`--all`/`--list`). Like every inscope command it auto-applies, and it infers the workspace from the directory you run it in.

Content is stored once in `~/.config/inscope/skills-cache/`; the personal skills dir only holds symlinks into it, so `skill update` refreshes every workspace that links a source at once. inscope only ever removes symlinks it created (links into that cache), so a skill directory you authored by hand in `~/.claude/skills` is never touched.

Personal scope is what makes this work everywhere with no per-repo setup and no launch flags: Claude reads `~/.claude/skills` (or an isolated login's `.inscope/skills`) in every session, regardless of the git repo you happen to be in, and lists those skills in the `/` menu. Nothing is added at launch time, so a shell, an IDE, cmux, or a `--resume` all see the same skills.

Every workspace also gets the bundled **inscope self-skill** by default: a short guide that teaches Claude how to drive inscope, so asking Claude to "add a skill here" or "isolate this workspace" uses the right commands. Opt a workspace out with `inscope skill rm inscope`, and back in with `inscope skill add inscope`.

To give Claude the inscope skill in a repo or agent that inscope does not manage, install it with the standard [`skills`](https://github.com/vercel-labs/skills) CLI, which ships the same `skills/inscope` guide:

```sh
npx skills add nrjdalal/inscope
```

---

## 🤖 MCP Servers

Each enabled server is written into the workspace `.mcp.json` with a name suffixed by the workspace label (for example `github-acme`), so servers from different workspaces never collide.

| Server      | Transport | Auth                                                       |
| ----------- | --------- | ---------------------------------------------------------- |
| `github`    | http      | token fetched at connect from the workspace's `gh` account |
| `atlassian` | http      | OAuth (Jira / Confluence)                                  |
| `canva`     | http      | OAuth                                                      |
| `clickup`   | http      | OAuth                                                      |
| `hubspot`   | http      | OAuth                                                      |
| `intercom`  | http      | OAuth                                                      |
| `linear`    | http      | OAuth                                                      |
| `monday`    | http      | OAuth                                                      |
| `notion`    | http      | OAuth                                                      |
| `plane`     | http      | OAuth                                                      |
| `sentry`    | http      | OAuth                                                      |
| `slack`     | stdio     | `SLACK_MCP_XOXP_TOKEN` from the macOS Keychain             |
| `stripe`    | http      | OAuth                                                      |
| `vercel`    | http      | OAuth                                                      |
| `webflow`   | http      | OAuth                                                      |

GitHub auth is fetched at connect time (a `headersHelper` in `.mcp.json` runs `gh auth token` for the workspace's account), so it works under any launcher, a terminal, an IDE, cmux, or a `--resume`, not just a shell that pre-set an env var. Slack reads `SLACK_MCP_XOXP_TOKEN`, which the hook exports from the Keychain on `cd`.

Because `.mcp.json` is project-scoped, Claude Code asks you to trust the workspace's MCP servers the first time you open `claude` there (its own project-server approval, not inscope's); approve once and github/slack connect. This is unchanged from any project `.mcp.json`.

Slack is opt-in. Enable it during `add`, or with flags, then store the token once:

```sh
npx inscope add ~/acme --gh neeraj-acme-org --servers github,slack --seed-slack
```

`--seed-slack` prompts for the `xoxp` token and writes it to the Keychain. Pass `--slack-message` to allow the Slack MCP server to post messages.

The Slack setup also lets you pick the server package: [`@nrjdalal/slack-mcp-server`](https://www.npmjs.com/package/@nrjdalal/slack-mcp-server) (kept on `latest`, the default) or the original [`slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server) (pinned to a known-good version). Choose it in the prompt, or pass `--slack-package slack-mcp-server`.

You need a Slack app with a user OAuth (`xoxp`) token first. If you don't have one, follow the [slack-mcp-server authentication guide](https://github.com/korotovsky/slack-mcp-server/blob/HEAD/docs/01-authentication-setup.md#option-2-using-slack_mcp_xoxp_token-user-oauth). inscope points you there during `add` when Slack is enabled.

---

## 📋 Config File

The source of truth is `~/.config/inscope/inscope.json`:

```jsonc
{
  "version": 1,
  // optional: skip permission prompts in every isolated login (written into each
  // workspace's own .inscope/settings.json; your shared ~/.claude is left to you)
  "bypass": true,
  "workspaces": [
    {
      // optional: run claude on this workspace's own login in ~/acme/.inscope
      "isolate": true,
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
      // optional: Claude skills, symlinked into your personal skills dir (~/.claude/skills,
      // or the workspace's own .inscope/skills when isolated)
      "skills": [
        "owner/repo#skills/readme-audit",
        { "name": "triage", "source": "owner/repo", "path": "slack", "ref": "main" },
      ],
    },
  ],
}
```

Edit it directly, then run `inscope apply` to regenerate the hook, git includes, and every `.mcp.json`. `inscope doctor` will tell you if anything no longer resolves.

---

## 📦 Install Globally

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
