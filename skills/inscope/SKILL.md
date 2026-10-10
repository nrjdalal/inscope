---
name: inscope
description: Manage per-workspace Claude Code identity with inscope (the GitHub account, git commit email, MCP servers, an isolated Claude login, named Claude accounts, or skills for a directory). Use when the user wants to add, edit, remove, or inspect a workspace or its skills, log a Claude account in or out, move a workspace to another account, or see their Claude usage limits.
---

# inscope

inscope gives each **workspace** (a directory) its own Claude Code identity: a Claude login/subscription (shared or isolated), MCP servers, a GitHub account, a git commit email, and its own skills. It resolves from the current directory on every `cd`, so identity follows location.

Change identity through inscope so its generated files stay in sync. The source of truth is `~/.config/inscope/inscope.json`; from it inscope regenerates the zsh hook, the git `includeIf` block, each workspace's `.mcp.json`, and its Claude skill symlinks.

## Rules

- Mutating commands (`add`, `edit`, `rm`, `skill add/rm/update`) apply in one step. Reach for `inscope apply` (alias `sync`) only to re-sync after editing `inscope.json` by hand.
- The workspace is inferred from the current directory (the hook's most-specific-path match). Target another with `--workspace <label>` on skill commands, or a path/label positional on `edit`/`rm`.
- Call the entity a **workspace**.
- After adding a skill, start a fresh `claude` session to pick it up (personal skills load at launch); editing a linked local skill's content updates live, unless it was added under a custom `--name` (a rewritten copy), which `inscope skill update` refreshes.
- Skills are symlinked from a shared cache into the workspace's personal Claude skills dir, so Claude lists them in the `/` menu everywhere: an isolated workspace keeps them private in its own `.inscope/skills`, a non-isolated one shares `~/.claude/skills`.
- An isolated login is delivered by exporting `CLAUDE_CONFIG_DIR` from the hook (not a `claude` wrapper), so any launcher that inherits the shell (a terminal, cmux, an IDE) runs on it and cmux session restore still works.
- To skip Claude's permission prompts in isolated logins, set top-level `bypass: true` in `inscope.json` (no CLI flag), then `inscope apply`; it writes `defaultMode: bypassPermissions` plus the pre-accepted bypass dialog (`skipDangerousModePermissionPrompt: true`) into each `.inscope/settings.json`, so a fresh login skips the one-time warning and background sessions are not refused. Without it, Claude Code v2.1.283+ starts interactive sessions in auto mode (a classifier reviews actions; v2.1.228+ on Pro, Max, and Team plans). Claude offers once to switch a login's `defaultMode` to auto; accepting rewrites it, so tell the user to decline, and if it happened, `inscope doctor` flags it and `inscope apply` restores bypass. A resumed session that ended in bypass restarts in the mode a new session would, so the setting (not the old session) decides. The shared `~/.claude` login is the user's own to configure, and an org's managed settings can disable bypass entirely (`inscope doctor` flags that).

- **Accounts** are named Claude logins inscope keeps outside any workspace (`~/.config/inscope/accounts/<name>`). A workspace runs on one with `account: <name>` (excludes `isolate`); several workspaces can share an account, and moving a workspace to another account is one flag. The hook exports the account's dir as `CLAUDE_CONFIG_DIR`, so the change reaches the next `claude` launched there (a running session keeps its login, and `--resume` only sees sessions from the account it ran on).
- Drive everything from this conversation; never ask the user to open another terminal. Every command below has flags for a non-interactive run, and a login is driven through its browser window (see **Logging in an account**).

## Commands

`inscope <command> --help` prints the exact flags.

### Workspaces

- `inscope add [path]`: map a workspace; on the first run it also creates the config, the chpwd hook, and the `~/.zshrc` source line (there is no separate init). Flags skip prompts: `--gh <account>`, `--email`/`--git-name` (per-workspace git identity, else inherits global), `--isolate` (own Claude login in a gitignored `<path>/.inscope`), `--servers <list>`, `--datadog-site <us1|us3|us5|eu|ap1|ap2|uk1>` (Datadog's regional MCP host; stored as `servers.datadog.site`), the Nylas options (`--nylas-region us|eu`, `--nylas-keychain`, `--seed-nylas`; Nylas authenticates with an API key read from the macOS keychain at connect time, not OAuth), `--label`, the Slack options, `-y`. Re-running `add` with an existing label updates that workspace: the flags you pass change it and everything else (isolation, servers and their settings, gh, git identity, skills) is kept, so `inscope add <path> --email new@x.dev -y` is the non-interactive way to change one field. To turn a boolean off that way, use its negation: `--no-isolate` (the old `.inscope` login is left in place, with a printed `rm -rf` to delete it) or `--no-slack-message`.
- `inscope status` (`whoami`): show the identity resolved for the current directory, the Claude login (email + subscription, from `claude auth status`) and whether it is shared or isolated, the GitHub account and token, the git email, MCP servers, and skills. `--json` for scripting.
- `inscope list` (`ls`): show workspaces with their identity, servers, and skills. `--json` for scripting.
- `inscope edit [path|label]`: change a workspace through the same prompts.
- `inscope rm [path|label]`: unmap a workspace (drops its git include, managed MCP servers, and skill links). Confirms by typing the label; `-y` skips it.

### Accounts

- `inscope login <name> [--email <email>] [--browser agent|system|none]`: sign a Claude account in as a named account, through Claude Code's own `claude auth login` on the account's dir (Claude keeps the token in its own Keychain slot; inscope never sees it). With agent-browser installed it opens the sign-in page in a fresh, isolated agent-browser session named `inscope-login-<name>` (printed as `agent-browser session: ...`), so accounts never share cookies. Afterwards it reads back the account that actually signed in and refuses (signing it back out) if it is not `--email`, or if that Claude account is already another named account. Re-running on an existing name signs it in again.
- `inscope logout <name>`: sign an account out (its Keychain token is deleted) and forget it. Refused while a workspace uses it.
- `inscope usage [--refresh] [--json]`: each login's 5-hour and weekly usage and time to reset, for the base login, every account, and every signed-in isolated workspace, with the workspaces using each. Read-only: a login whose token expired shows as expired, and `--refresh` first lets Claude Code refresh it with a one-word Haiku prompt.
- Assign: `inscope add <path> --account <name> -y` (or pick it in `inscope edit`); `--isolate` switches back to an own `.inscope` login, `--account none` back to the shared one.

### Skills

- `inscope skill add <source>`: add skill(s). A source is a GitHub `owner/repo` (or a browser `tree`/`blob` URL), a git URL, or a local path, with an optional `#subdir`. A multi-skill source lists its skills to pick from. Flags: `-w/--workspace`, `-l/--list`, `-s/--skill <name>` (repeatable, `*` for all), `--all`, `-n/--name`, `--ref <branch|tag|sha>`, `-y`. A skill name already taken in the skills dir is refused, never replaced: by something inscope did not create (the user's own skill dir or link), or, in the shared `~/.claude/skills`, by another non-isolated workspace that declares that name from a different source (install it under another name with `--name`; `skill rename` and turning isolation off are refused the same way). The bundled self-skill is the exception: if the inscope skill is already installed at `~/.claude/skills/inscope` another way (e.g. `npx skills add nrjdalal/inscope`), inscope leaves that install alone and counts it as linked.
- `inscope skill list`: the workspace's skills and their link status.
- `inscope skill rename <old> <new>` (alias `mv`): rename a skill and its `/command`; re-links under the new name and prunes the old. Cannot rename the reserved `inscope` self-skill.
- `inscope skill rm <name>`: remove a skill. `rm inscope` opts out of the bundled self-skill; `add inscope` re-enables it.
- `inscope skill update`: pull the workspace's floating git skills.

### Checking

- `inscope doctor`: verify tokens, identities, the hook, and skill links resolve, each with its fix. `--json` for scripting (exits non-zero if any check fails).
- `inscope diff`: preview what apply would change (hook, git includes, `.mcp.json`, skills). `--adopt` folds config-expressible on-disk `.mcp.json` settings back in; `--exit-code` gates CI.

## Logging in an account

Run the whole sign-in from the conversation:

1. Ask for the account's email if you do not have it, and a short name for it (e.g. `work`, `alt`).
2. Start `inscope login <name> --email <email>` in the **background** (it waits until the sign-in completes). It prints `agent-browser session: inscope-login-<name>` and opens Claude's sign-in page in that session.
3. Drive that window with `agent-browser --session inscope-login-<name> ...`: `snapshot -i` to see the page, then fill or confirm the email and continue. Prefer the email-code path; if the page offers only Google or SSO, ask the user to finish it in the visible window.
4. When Claude emails a verification code, ask the user: "What's the verification code Claude just emailed to <email>?" Type it in and continue. On the authorization page for Claude Code, approve.
5. The page redirects to a local callback and the background `inscope login` finishes: read its output for `✓ account "<name>" -> <email>` (or its error) and report it. Never type a password, and never read, print, or store a token.

Then offer to assign it (`inscope add <path> --account <name> -y`) and show `inscope usage`.

## Recipes

- **Personal, work, client:** `inscope add ~/personal --gh personal-account --email you@personal.com` (shared login), `inscope add ~/work --gh work-account --email you@work.com --isolate` (its own login), `inscope add ~/clients/acme --isolate` (a client on its own login and subscription).
- **Who am I here:** `inscope status` (or `whoami`) prints the resolved Claude login and subscription, GitHub account, git email, MCP servers, and skills.
- **Skill in the current workspace:** `inscope skill add owner/repo#skills/the-skill`, or `inscope skill add owner/repo --list` to browse first.
- **Wrong account here:** run `inscope doctor` in the directory; it names the resolved workspace and whether its token and identity are present, says to run `inscope apply` if the hook is stale, then relaunch.
- **Several accounts:** `inscope login work --email you@work.com`, `inscope login alt --email you@alt.com`, then `inscope add ~/work --account work -y`. To move `~/work` when it nears its limit: `inscope usage`, then `inscope add ~/work --account alt -y` and relaunch `claude` there.
