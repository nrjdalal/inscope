# Inscope

<!--
  Agents: the full guide to driving inscope (every flag, the proxy, pools, sign-in
  rules) is the bundled skill, skills/inscope/SKILL.md. Keep this README short.
-->

**Per-directory identity for Claude Code, with your Claude accounts pooled behind a local proxy.**

[![Twitter](https://img.shields.io/twitter/follow/nrjdalal_dev?label=%40nrjdalal_dev)](https://twitter.com/nrjdalal_dev)
[![npm](https://img.shields.io/npm/v/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![downloads](https://img.shields.io/npm/dt/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![stars](https://img.shields.io/github/stars/nrjdalal/inscope?color=blue)](https://github.com/nrjdalal/inscope)

`cd` into a directory and Claude Code is the right you: its GitHub account, git email, MCP servers, and skills. Hit an account's limit and the conversation just carries on with your next account.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/status-hero.png" alt="inscope status in three directories" width="900" />
</p>

---

## 📖 Some Examples

```sh
# map a directory (prompts for everything, or pass flags)
npx inscope add ~/work --gh neeraj-work --email neeraj@work.com
# give it its own Claude history, settings, and skills
npx inscope add ~/clients/acme --isolate
# sign your Claude accounts in (once each)
npx inscope login
# keep work accounts for work only
npx inscope login --pool work
npx inscope add ~/work --pool work
# who am I here, and how much is left
npx inscope status
npx inscope usage
```

Or just ask Claude: `npx skills add nrjdalal/inscope`, then _"map ~/work with my work GitHub account"_.

---

## ✨ Features

- 🪪 GitHub token and git commit email per directory
- 🤖 MCP servers per directory (GitHub, Slack, Notion, Linear, Stripe, and 14 more)
- 🎓 Skills per directory, in Claude's `/` menu
- 🔁 All your Claude accounts pooled: a conversation carries on past an account's limit
- 🧰 Pools keep work accounts for work and personal for personal
- 🔒 Isolated Claude config per directory, when you want one
- 🔐 GitHub and MCP tokens come from `gh` and the macOS Keychain; Claude account tokens stay in the proxy's owner-only folder
- 🚀 Works under any launcher: terminal, IDE, cmux, `--resume`

---

## 🚀 Commands

| Command                  | What it does                                               |
| ------------------------ | ---------------------------------------------------------- |
| `inscope add [path]`     | Map a directory (`--isolate`, `--pool`, `--gh`, `--email`) |
| `inscope status`         | Who you are here (alias `whoami`)                          |
| `inscope list`           | Your workspaces (alias `ls`)                               |
| `inscope edit [path]`    | Change a workspace                                         |
| `inscope rm [path]`      | Unmap a workspace                                          |
| `inscope skill`          | `add`, `list`, `rename`, `rm`, `update` skills             |
| `inscope login`          | Sign a Claude account in (`--pool <name>`)                 |
| `inscope logout <email>` | Remove a Claude account                                    |
| `inscope pool list`      | Your pools and who uses each                               |
| `inscope usage`          | 5-hour and weekly usage per account                        |
| `inscope proxy`          | `status`, `start`, `stop`, `setup`, `uninstall`            |
| `inscope doctor`         | Check that everything resolves                             |
| `inscope diff`           | Preview what `apply` would change                          |
| `inscope apply`          | Regenerate everything from the config (alias `sync`)       |

Every command takes `-h`.

<details>
<summary>Watch each command</summary>

|            |                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------- |
| **add**    | ![add](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/add.gif)       |
| **status** | ![status](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/status.gif) |
| **list**   | ![list](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/list.gif)     |
| **edit**   | ![edit](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/edit.gif)     |
| **rm**     | ![rm](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/rm.gif)         |
| **doctor** | ![doctor](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/doctor.gif) |
| **diff**   | ![diff](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/diff.gif)     |
| **apply**  | ![apply](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/apply.gif)   |

</details>

---

## 🔁 Accounts and pools

- `inscope login` signs an account in, in a fresh Chrome window. You sign in; nothing is pre-filled.
- Every Claude login goes through a local proxy ([CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), `127.0.0.1` only) that holds your accounts.
- At an account's limit, the proxy moves the conversation to the next account.
- `--pool <name>` makes a separate pool, e.g. for the two accounts your work gave you.
- `inscope usage` shows each account's 5-hour and weekly limits.
- Behind the proxy, Claude's claude.ai connectors and Remote Control are off.

> Anthropic's terms forbid third parties that store or relay Claude.ai credentials, which is what a proxy like this does. Running it is your choice and your accounts' risk.

<!--
  Details for agents: the proxy is a pinned, checksum-verified CLIProxyAPI run as a
  launchd agent (dev.inscope.proxy, and dev.inscope.proxy.<pool> per named pool). apply
  writes env.ANTHROPIC_BASE_URL plus a Keychain apiKeyHelper into ~/.claude/settings.json
  and each isolated .inscope/settings.json, and refuses to overwrite a key helper you set.
  A pool needs an isolated workspace. An account lives in one pool only. Behind the
  proxy, claude.ai connectors and Remote Control are off. See skills/inscope/SKILL.md.
-->

---

## 🤖 MCP servers

`github` · `atlassian` · `canva` · `clickup` · `datadog` · `hubspot` · `intercom` · `linear` · `monday` · `notion` · `nylas` · `plane` · `posthog` · `sentry` · `slack` · `stripe` · `vercel` · `webflow` · `xquik`

One `.mcp.json` per workspace, each server suffixed with its workspace (`github-work`), so nothing collides.

<!--
  Details for agents: GitHub auth comes from `gh auth token` at connect time; Slack and
  Nylas read Keychain tokens (--seed-slack, --seed-nylas); --slack-message allows posting;
  --datadog-site picks the Datadog region; the rest are OAuth in Claude Code.
-->

---

## 🎓 Skills

```sh
npx inscope skill add owner/repo   # pick from a repo's skills
npx inscope skill list             # what this workspace has
npx inscope skill update           # refresh git sources
```

---

## ⚙️ Config

One file, `~/.config/inscope/inscope.json`. Edit it and run `inscope apply`, or let the commands write it.

```jsonc
{
  "version": 1,
  "bypass": true, // skip permission prompts in isolated configs
  "proxy": { "port": 8317 }, // your accounts' proxy (from inscope login)
  "pools": [{ "name": "work", "port": 8318 }], // a separate pool
  "workspaces": [
    {
      "isolate": true, // its own Claude config in ~/work/.inscope
      "name": "work",
      "pool": "work", // only work accounts answer here
      "path": "~/work",
      "gh": "neeraj-work",
      "git": { "email": "neeraj@work.com" },
      "servers": { "github": true, "linear": true },
    },
  ],
}
```

---

## Requirements

macOS, zsh, and [Claude Code](https://claude.com/claude-code). [`gh`](https://cli.github.com) for workspaces with a GitHub account.

## Contributing

Issues and PRs welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md).

## More tools

[gitpick](https://github.com/nrjdalal/gitpick) · [zerostarter](https://github.com/nrjdalal/zerostarter) · more at [github.com/nrjdalal](https://github.com/nrjdalal)

## License

[MIT](./LICENSE) © [Neeraj Dalal](https://nrjdalal.com)
