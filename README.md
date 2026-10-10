# Inscope

**Per-workspace identity for Claude Code: each directory auto-resolves its own Claude config, MCP servers, GitHub account, and skills, and all your Claude accounts are pooled so a conversation carries on past an account's limit.**

[![Twitter](https://img.shields.io/twitter/follow/nrjdalal_dev?label=%40nrjdalal_dev)](https://twitter.com/nrjdalal_dev)
[![npm](https://img.shields.io/npm/v/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![downloads](https://img.shields.io/npm/dt/inscope?color=red&logo=npm)](https://www.npmjs.com/package/inscope)
[![stars](https://img.shields.io/github/stars/nrjdalal/inscope?color=blue)](https://github.com/nrjdalal/inscope)

`cd` into a directory and Claude Code becomes the right person for it. No profiles to switch, no global toggles, no launch flags, and it holds up with a dozen Claude Code sessions open at once.

`inscope status` (alias `whoami`) shows who you are in any directory: the Claude config and the proxy behind it, MCP servers, GitHub account, git email, and skills.

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/status-hero.png" alt="inscope status in three directories: personal on the shared max login, then work and the acme client each on their own isolated team login" width="900" />
</p>

---

## Why inscope

- 🎫 **All your Claude accounts, one pool.** Sign each in once; when the account serving a conversation hits its limit, the conversation carries on with the next one, with no re-login and no restart. Isolate a workspace to give it its own history, settings, and skills.
- 🤖 **MCP servers per workspace.** GitHub, Slack, and 14 one-click OAuth connectors (Notion, Linear, Stripe, Xquik, and more), uniquely named so nothing ever collides between workspaces.
- 🪪 **The right git identity, always.** GitHub token and commit email resolved live from `$PWD`, so every commit lands as the right you.
- 🎓 **Skills per workspace.** A curated `/` menu per directory, shared into your Claude skills dir with zero per-repo setup.
- 🔐 **Nothing sensitive on disk.** Tokens come from the `gh` keyring and the macOS Keychain. 🧵 Race-free across sessions. 🚀 Works under any launcher (terminal, IDE, cmux, `--resume`).

📖 The design, in depth: [Race-Free Identity in Claude Code](https://zerostarter.dev/blog/mcp-per-workspace).

---

## Quick start

### Setup via agent (recommended)

Add the inscope skill and let your AI agent (Claude Code) do the whole setup, no CLI to learn:

```sh
npx skills add nrjdalal/inscope
```

Then just ask, e.g. _"map my ~/work and ~/personal directories with inscope, work on its own login."_ The agent runs the right commands and answers the prompts for you.

### Interactive CLI

```sh
npx inscope add                            # guided setup: prompts for the directory + every option
npx inscope add ~/work                     # a path just pre-fills the directory prompt
npx inscope add ~/clients/acme --isolate   # any flag pre-fills a prompt (--isolate = its own Claude config)
```

Sign each GitHub account into `gh` once (`gh auth login`); inscope reads their tokens. The first `add` prompts you to reload your shell (a new terminal works too) so the hook loads; then `cd ~/work` and you're the work account with work servers and email, `cd ~/clients/acme` and you're in the client's isolated Claude config.

**Sign in your Claude accounts.** `inscope login` signs a Claude account in: a new Chrome window on a fresh profile opens Anthropic's sign-in page, and you sign in there (`--browser system` uses your usual browser instead, `--browser none` prints the URL, `--email` checks who signed in, and `--port` picks the first proxy's port). Run it once per account. Every account lives in a local proxy, a pinned, checksum-verified [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) that the first sign-in installs and runs at login, bound to `127.0.0.1` with a random client key (kept in the Keychain) and its management API and web panel off. Every Claude Code login goes through it: inscope writes `env.ANTHROPIC_BASE_URL` and an `apiKeyHelper` that reads the key from the Keychain into the shared `~/.claude/settings.json` and each isolated workspace's, touching nothing else there (it refuses, rather than overwrite, a key helper or base URL of your own). When the account serving a conversation answers that it hit its limit (the switch happens at the limit itself, not at a percentage before it), the proxy sends the same request to the next account and the conversation stays there, so you keep chatting with no re-login, no restart, and nothing to switch. `inscope usage` shows each account's plan and its 5-hour and weekly usage, `inscope logout <email>` removes an account, and `inscope proxy` holds the low-level controls (`status`, `start`, `stop`, `setup [--pool <name>] [--port <n>]`, and `uninstall`, which sends every login straight to Anthropic again; `--purge` also removes the accounts). Behind the proxy, Claude Code turns MCP tool search off by default and disables Remote Control and claude.ai connectors. The accounts' tokens live only in the proxy's owner-only folder (`~/.config/inscope/proxy/auth`, where CLIProxyAPI also keeps its last 10 failed requests, credentials masked), which is exactly what Anthropic's terms forbid third parties to do with Claude.ai credentials: running it is your choice and your accounts' risk. Or skip the terminal: ask Claude to "sign in my work account"; it opens the sign-in window and confirms once you are through.

**Keep accounts apart with pools.** Your work gave you two accounts and you want only work conversations on them? `inscope login --pool work` for each (the first creates the `work` pool, its own proxy on the next free port), then `inscope add ~/work --pool work`. `~/work` then rotates only between those two, while your shared login and every other workspace stay on the default pool. An account lives in one pool only; `inscope pool list` shows each pool and who uses it, and `inscope usage` adds a POOL column.

`--isolate` (or the "Separate Claude config?" prompt) gives that workspace its own Claude config in a gitignored `.inscope` dir: its own history, settings, and skills, still going through the proxy. The hook exports `CLAUDE_CONFIG_DIR` (not a `claude` wrapper), so any launcher (terminal, IDE, cmux, `--resume`) lands on the right config. Set top-level `bypass: true` to skip permission prompts there (Claude Code v2.1.283+ otherwise starts interactive sessions in auto mode); it also pre-accepts Claude's one-time bypass warning, so fresh configs and background sessions start bypassed right away. If Claude offers to switch you to auto mode, decline: accepting rewrites the config's `defaultMode` (`inscope doctor` flags it, `inscope apply` restores it). Bypass is never written to your shared `~/.claude`.

Prefer flags or CI? Every prompt has one, and `-y` takes the defaults. Reaching for it a lot? `npm i -g inscope` and drop the `npx`.

Bare `inscope add` prompts for the directory (defaulting to where you are); passing a path just pre-fills that prompt. Either way it walks you through the Claude config, MCP servers, GitHub account, git identity, and skills:

<p align="center">
  <img src="https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/add.gif" alt="inscope add two ways: bare add maps the current directory (first-run bootstrap), then add with an explicit path adds Slack and an isolated login" width="900" />
</p>

---

## Commands

| Command                  | What it does                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inscope add [path]`     | Map a workspace (Claude config, MCP servers, GitHub account, git email, skills); sets up inscope on first run. Re-running it on a label updates that workspace and keeps whatever you do not pass (`--no-isolate` turns isolation off) |
| `inscope status`         | Show the identity resolved for the current directory (alias `whoami`)                                                                                                                                                                  |
| `inscope list`           | List configured workspaces (alias `ls`)                                                                                                                                                                                                |
| `inscope edit [path]`    | Change a workspace through the same prompts                                                                                                                                                                                            |
| `inscope rm [path]`      | Unmap a workspace (alias `remove`)                                                                                                                                                                                                     |
| `inscope skill`          | Manage a workspace's Claude skills (`add`, `list`, `rename`, `rm`, `update`)                                                                                                                                                           |
| `inscope login`          | Sign a Claude account in (into the local proxy every Claude Code login goes through; `--pool <name>` for a workspace's own pool)                                                                                                       |
| `inscope logout <email>` | Remove a Claude account from the proxy (from whichever pool holds it)                                                                                                                                                                  |
| `inscope pool list`      | Your pools of Claude accounts, their accounts, and who uses each                                                                                                                                                                       |
| `inscope usage`          | Each account's plan, 5-hour and weekly usage, and when each resets                                                                                                                                                                     |
| `inscope proxy`          | The proxy's low-level controls (`status`, `start`, `stop`, `setup`, `uninstall`)                                                                                                                                                       |
| `inscope doctor`         | Verify tokens, identities, the hook, and skill links resolve                                                                                                                                                                           |
| `inscope diff`           | Preview what `apply` would change; `--adopt` pulls on-disk extras back                                                                                                                                                                 |
| `inscope apply`          | Regenerate the hook, git includes, `.mcp.json`, and skill links (alias `sync`)                                                                                                                                                         |

Run any command with `-h` for its flags. Mutating commands apply in one step; `apply` is only for after you hand-edit the config.

<details>
<summary>Watch each command</summary>

|            |                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------- |
| **status** | ![status](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/status.gif) |
| **list**   | ![list](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/list.gif)     |
| **edit**   | ![edit](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/edit.gif)     |
| **rm**     | ![rm](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/rm.gif)         |
| **doctor** | ![doctor](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/doctor.gif) |
| **diff**   | ![diff](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/diff.gif)     |
| **apply**  | ![apply](https://raw.githubusercontent.com/nrjdalal/inscope/main/.github/assets/apply.gif)   |

</details>

---

## MCP servers

One `.mcp.json` per workspace, each server suffixed with the workspace label (`github-work`) so nothing collides. GitHub auth is fetched at connect time (`gh auth token`); Nylas reads its API key from the Keychain at connect time; Slack reads a Keychain token exported by the hook; the rest are OAuth.

`github` · `atlassian` · `canva` · `clickup` · `datadog` · `hubspot` · `intercom` · `linear` · `monday` · `notion` · `nylas` · `plane` · `posthog` · `sentry` · `slack` · `stripe` · `vercel` · `webflow` · `xquik`

Slack is opt-in (`--seed-slack` stores the `xoxp` token, `--slack-message` allows posting and `--no-slack-message` turns it back off). Datadog serves each region from its own host, so pick yours with `--datadog-site` (`us1` default, `us3`, `us5`, `eu`, `ap1`, `ap2`, `uk1`), stored as `"datadog": { "site": "datadoghq.eu" }`. Nylas has no OAuth: it sends your Nylas API key as a Bearer header, read from the Keychain at connect time (`--seed-nylas` stores it, `--nylas-region eu` for EU apps). PostHog uses one endpoint and routes US and EU accounts itself. OAuth connectors, including Datadog, PostHog, and Xquik, authenticate in Claude Code at connect time. Claude Code asks you to trust a workspace's servers the first time you open `claude` there; approve once.

---

## Skills

Give a workspace its own `/` menu. `inscope skill add owner/repo#skills/the-skill` clones once into a shared cache and symlinks it into your Claude skills dir, so it loads in every session under any launcher, no per-repo setup.

```sh
npx inscope skill add owner/repo         # pick from a repo's skills
npx inscope skill list                   # what this workspace has
npx inscope skill update                 # refresh floating git sources
```

Every workspace also gets the bundled **inscope self-skill**, so you can just ask Claude to "isolate this workspace" or "add a skill here." Install it anywhere with the [`skills`](https://github.com/vercel-labs/skills) CLI: `npx skills add nrjdalal/inscope`.

---

## Config

One file, `~/.config/inscope/inscope.json`. Edit it by hand and run `inscope apply`, or let the commands write it.

```jsonc
{
  "version": 1,
  "bypass": true, // skip permission prompts in isolated configs
  // the local proxy holding your Claude accounts, from `inscope login` (127.0.0.1 only);
  // every Claude Code login goes through it
  "proxy": { "port": 8317 },
  // named pools of accounts, each its own proxy, from `inscope login --pool <name>`
  "pools": [{ "name": "work", "port": 8318 }],
  "workspaces": [
    {
      "isolate": true, // its own Claude config in ~/work/.inscope
      "name": "work",
      "pool": "work", // only the work pool's accounts answer here
      "path": "~/work",
      "gh": "neeraj-work",
      "git": { "email": "neeraj@work.com" },
      "servers": { "github": true, "linear": true, "xquik": true },
    },
    {
      "isolate": true, // a client, its own config in ~/clients/acme/.inscope
      "name": "acme",
      "path": "~/clients/acme",
      "gh": "neeraj-acme",
      "git": { "email": "neeraj@acme.org" },
      "servers": { "github": true, "linear": true, "notion": true },
      "skills": ["owner/repo#skills/readme-audit"],
    },
    // a workspace without "isolate" shares your ~/.claude config (e.g. ~/personal)
  ],
}
```

`inscope` only edits the blocks it manages inside `.zshrc`, `.gitconfig`, and `.mcp.json`, and every write is atomic, so the rest of those files is left alone.

---

## Requirements

macOS, zsh, and [Claude Code](https://claude.com/claude-code). [`gh`](https://cli.github.com) only for workspaces that scope a GitHub account.

## Contributing

Issues and PRs welcome. `bun test` and `bun run typecheck` before opening one; see [CONTRIBUTING.md](./CONTRIBUTING.md).

## More tools

[gitpick](https://github.com/nrjdalal/gitpick) · [zerostarter](https://github.com/nrjdalal/zerostarter) · more at [github.com/nrjdalal](https://github.com/nrjdalal)

## License

[MIT](./LICENSE) © [Neeraj Dalal](https://nrjdalal.com)
