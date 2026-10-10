---
name: inscope
description: Manage per-workspace Claude Code identity with inscope (the GitHub account, git commit email, MCP servers, an isolated Claude config, or skills for a directory) and the user's Claude accounts, which inscope pools behind one local proxy. Use when the user wants to add, edit, remove, or inspect a workspace or its skills, sign a Claude account in or out, or see their Claude usage limits.
---

# inscope

inscope gives each **workspace** (a directory) its own Claude Code identity: a Claude config (shared or isolated), MCP servers, a GitHub account, a git commit email, and its own skills. It resolves from the current directory on every `cd`, so identity follows location. The user's Claude accounts are pooled: each signs in once (`inscope login`) into a local proxy, every Claude Code login goes through it, and a conversation carries on with the next account when one hits its limit.

Change identity through inscope so its generated files stay in sync. The source of truth is `~/.config/inscope/inscope.json`; from it inscope regenerates the zsh hook, the git `includeIf` block, each workspace's `.mcp.json`, and its Claude skill symlinks.

## Rules

- Mutating commands (`add`, `edit`, `rm`, `skill add/rm/update`) apply in one step. Reach for `inscope apply` (alias `sync`) only to re-sync after editing `inscope.json` by hand.
- The workspace is inferred from the current directory (the hook's most-specific-path match). Target another with `--workspace <label>` on skill commands, or a path/label positional on `edit`/`rm`.
- Call the entity a **workspace**.
- After adding a skill, start a fresh `claude` session to pick it up (personal skills load at launch); editing a linked local skill's content updates live, unless it was added under a custom `--name` (a rewritten copy), which `inscope skill update` refreshes.
- Skills are symlinked from a shared cache into the workspace's personal Claude skills dir, so Claude lists them in the `/` menu everywhere: an isolated workspace keeps them private in its own `.inscope/skills`, a non-isolated one shares `~/.claude/skills`.
- An isolated config is delivered by exporting `CLAUDE_CONFIG_DIR` from the hook (not a `claude` wrapper), so any launcher that inherits the shell (a terminal, cmux, an IDE) runs on it and cmux session restore still works.
- To skip Claude's permission prompts in isolated configs, set top-level `bypass: true` in `inscope.json` (no CLI flag), then `inscope apply`; it writes `defaultMode: bypassPermissions` plus the pre-accepted bypass dialog (`skipDangerousModePermissionPrompt: true`) into each `.inscope/settings.json`, so a fresh login skips the one-time warning and background sessions are not refused. Without it, Claude Code v2.1.283+ starts interactive sessions in auto mode (a classifier reviews actions; v2.1.228+ on Pro, Max, and Team plans). Claude offers once to switch a login's `defaultMode` to auto; accepting rewrites it, so tell the user to decline, and if it happened, `inscope doctor` flags it and `inscope apply` restores bypass. A resumed session that ended in bypass restarts in the mode a new session would, so the setting (not the old session) decides. Bypass is never written to the shared `~/.claude`, and an org's managed settings can disable bypass entirely (`inscope doctor` flags that).

- **Every login goes through the proxy** once an account is signed in: inscope writes `env.ANTHROPIC_BASE_URL` (the proxy, `http://127.0.0.1:<port>`) and an `apiKeyHelper` that reads its client key from the Keychain (`INSCOPE_PROXY_KEY`) into the shared `~/.claude/settings.json` and each isolated `.inscope/settings.json`, touching nothing else there. It refuses, rather than overwrite, a key helper or base URL the user set by hand; say what to remove. Behind the proxy, Claude Code turns MCP tool search off by default and disables Remote Control and claude.ai connectors; Claude Code sessions started afterwards use it.
- The proxy stores the accounts' tokens itself, which Anthropic's terms forbid third parties to do with Claude.ai credentials: say so once when the user first signs in, then respect their choice.
- Drive everything from this conversation; never ask the user to open another terminal. Every command below has flags for a non-interactive run, and a sign-in runs in the background while the user signs in themselves (see **Signing in an account**).

## Commands

`inscope <command> --help` prints the exact flags.

### Workspaces

- `inscope add [path]`: map a workspace; on the first run it also creates the config, the chpwd hook, and the `~/.zshrc` source line (there is no separate init). Flags skip prompts: `--gh <account>`, `--email`/`--git-name` (per-workspace git identity, else inherits global), `--isolate` (its own Claude config, for its own history, settings, and skills, in a gitignored `<path>/.inscope`), `--servers <list>`, `--datadog-site <us1|us3|us5|eu|ap1|ap2|uk1>` (Datadog's regional MCP host; stored as `servers.datadog.site`), the Nylas options (`--nylas-region us|eu`, `--nylas-keychain`, `--seed-nylas`; Nylas authenticates with an API key read from the macOS keychain at connect time, not OAuth), `--label`, the Slack options, `-y`. Re-running `add` with an existing label updates that workspace: the flags you pass change it and everything else (isolation, servers and their settings, gh, git identity, skills) is kept, so `inscope add <path> --email new@x.dev -y` is the non-interactive way to change one field. To turn a boolean off that way, use its negation: `--no-isolate` (the old `.inscope` is left in place, with a printed `rm -rf` to delete it) or `--no-slack-message`.
- `inscope status` (`whoami`): show the identity resolved for the current directory, the Claude config (shared or isolated) and, behind the proxy, how many accounts it holds (else the login's email and subscription, from `claude auth status`), the GitHub account and token, the git email, MCP servers, and skills. `--json` for scripting.
- `inscope list` (`ls`): show workspaces with their identity, servers, and skills. `--json` for scripting.
- `inscope edit [path|label]`: change a workspace through the same prompts.
- `inscope rm [path|label]`: unmap a workspace (drops its git include, managed MCP servers, and skill links). Confirms by typing the label; `-y` skips it.

### Accounts (all behind one proxy)

- `inscope login [--email <email>] [--browser chrome|system|none] [--port <n>]`: sign a Claude account in. The first one also sets the proxy up: installs the pinned, checksum-verified CLIProxyAPI, writes a hardened config (127.0.0.1 only, a random client key in the Keychain, management API and web panel off, session affinity, fill-first, immediate failover to the next account on a 429), runs it at login as the launchd agent `dev.inscope.proxy`, and routes every login through it. By default it opens a new Chrome window on a fresh, throwaway profile, straight on Claude's sign-in page with nothing pre-filled; the user signs in there, and the profile is deleted afterwards. `--browser system` opens the user's usual browser (not a fresh profile) and `--browser none` prints the URL; prefer the default. The account that signed in is checked against `--email` and removed if it differs. Signing an account in again renews it.
- `inscope logout <email>`: remove an account from the proxy. The last account is refused (every login goes through the proxy); `inscope proxy uninstall` stops using it instead.
- `inscope usage [--json]`: each account's plan, 5-hour and weekly usage, and time to reset. Read-only, with each account's token from the proxy, which keeps them fresh.
- Accounts switch when one answers that it hit its limit, not at a percentage before; the conversation stays on the next account.
- `inscope proxy status [--json]`, `start`, `stop` (Claude Code cannot reach Anthropic while it is stopped), `setup [--port <n>]` (reinstall, or move it to another port), `uninstall [--purge]` (every login goes straight to Anthropic again, each on its own Claude Code sign-in; `--purge` also removes the accounts). `inscope doctor` checks the install, key, config and token privacy, the running agent, the accounts, and that every login is routed. There is no web dashboard (off on purpose); use `status` and `usage`.

### Skills

- `inscope skill add <source>`: add skill(s). A source is a GitHub `owner/repo` (or a browser `tree`/`blob` URL), a git URL, or a local path, with an optional `#subdir`. A multi-skill source lists its skills to pick from. Flags: `-w/--workspace`, `-l/--list`, `-s/--skill <name>` (repeatable, `*` for all), `--all`, `-n/--name`, `--ref <branch|tag|sha>`, `-y`. A skill name already taken in the skills dir is refused, never replaced: by something inscope did not create (the user's own skill dir or link), or, in the shared `~/.claude/skills`, by another non-isolated workspace that declares that name from a different source (install it under another name with `--name`; `skill rename` and turning isolation off are refused the same way). The bundled self-skill is the exception: if the inscope skill is already installed at `~/.claude/skills/inscope` another way (e.g. `npx skills add nrjdalal/inscope`), inscope leaves that install alone and counts it as linked.
- `inscope skill list`: the workspace's skills and their link status.
- `inscope skill rename <old> <new>` (alias `mv`): rename a skill and its `/command`; re-links under the new name and prunes the old. Cannot rename the reserved `inscope` self-skill.
- `inscope skill rm <name>`: remove a skill. `rm inscope` opts out of the bundled self-skill; `add inscope` re-enables it.
- `inscope skill update`: pull the workspace's floating git skills.

### Checking

- `inscope doctor`: verify tokens, identities, the hook, and skill links resolve, each with its fix. `--json` for scripting (exits non-zero if any check fails).
- `inscope diff`: preview what apply would change (hook, git includes, `.mcp.json`, skills). `--adopt` folds config-expressible on-disk `.mcp.json` settings back in; `--exit-code` gates CI.

## Signing in an account

The user signs in; you only start it and report the result. Never fill in the sign-in page, click through it, or attempt its human checks (Cloudflare, hCaptcha) yourself: they are the user's to complete, and an automated sign-in gets flagged.

1. Ask for the account's email if you do not have it.
2. Start `inscope login --email <email>` in the **background** (it waits until the sign-in completes). A new Chrome window opens on Claude's sign-in page, on a fresh profile.
3. Tell the user, briefly: "A new Chrome window just opened on Claude's sign-in page. Enter <email>, then the code Claude emails you, complete any check it shows, and authorize. I'll confirm here when it's done."
4. When the background `inscope login` exits, read its output: `✓ <email> signed in` means it is in the proxy; otherwise report its error (a different account signed in, the sign-in was cancelled). Never read, print, or store a token.

Then show `inscope usage`.

## Recipes

- **Personal, work, client:** `inscope add ~/personal --gh personal-account --email you@personal.com` (shared config), `inscope add ~/work --gh work-account --email you@work.com --isolate` (its own history and settings), `inscope add ~/clients/acme --isolate`.
- **Who am I here:** `inscope status` (or `whoami`) prints the resolved Claude config (and the proxy behind it), GitHub account, git email, MCP servers, and skills.
- **Skill in the current workspace:** `inscope skill add owner/repo#skills/the-skill`, or `inscope skill add owner/repo --list` to browse first.
- **Wrong account here:** run `inscope doctor` in the directory; it names the resolved workspace and whether its token and identity are present, says to run `inscope apply` if the hook is stale, then relaunch.
- **Several accounts:** `inscope login --email you@work.com`, then `inscope login --email you@alt.com`. Every login now carries on with the other account when one hits its limit; `inscope usage` shows where each stands.
