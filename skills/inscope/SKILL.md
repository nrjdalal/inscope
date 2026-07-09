---
name: inscope
description: Manage per-workspace Claude Code identity with inscope (the GitHub account, git commit email, MCP servers, an isolated Claude login, or skills for a directory). Use when the user wants to add, edit, remove, or inspect a workspace or its skills.
---

# inscope

inscope gives each **workspace** (a directory) its own Claude Code identity: a GitHub account, a git commit email, MCP servers, an optional isolated Claude login, and its own skills. It resolves from the current directory on every `cd`, so identity follows location.

Change identity through inscope so its generated files stay in sync. The source of truth is `~/.config/inscope/inscope.json`; from it inscope regenerates the zsh hook, the git `includeIf` block, each workspace's `.mcp.json`, and its Claude skill symlinks.

## Rules

- Mutating commands (`add`, `edit`, `rm`, `skill add/rm/update`) apply in one step. Reach for `inscope apply` (alias `sync`) only to re-sync after editing `inscope.json` by hand.
- The workspace is inferred from the current directory (the hook's most-specific-path match). Target another with `--workspace <label>` on skill commands, or a path/label positional on `edit`/`rm`.
- Call the entity a **workspace**.
- After adding a skill, start a fresh `claude` session to pick it up (personal skills load at launch); editing a linked local skill's content updates live, unless it was added under a custom `--name` (a rewritten copy), which `inscope skill update` refreshes.
- Skills are symlinked from a shared cache into the workspace's personal Claude skills dir, so Claude lists them in the `/` menu everywhere: an isolated workspace keeps them private in its own `.inscope/skills`, a non-isolated one shares `~/.claude/skills`.
- An isolated login is delivered by exporting `CLAUDE_CONFIG_DIR` from the hook (not a `claude` wrapper), so any launcher that inherits the shell (a terminal, cmux, an IDE) runs on it and cmux session restore still works.
- To skip Claude's permission prompts in isolated logins, set top-level `bypass: true` in `inscope.json` (no CLI flag), then `inscope apply`; it writes `defaultMode: bypassPermissions` into each `.inscope/settings.json`. The shared `~/.claude` login is the user's own to configure.

## Commands

`inscope <command> --help` prints the exact flags.

### Workspaces

- `inscope add [path]`: map a workspace; on the first run it also creates the config, the chpwd hook, and the `~/.zshrc` source line (there is no separate init). Flags skip prompts: `--gh <account>`, `--email`/`--git-name` (per-workspace git identity, else inherits global), `--isolate` (own Claude login in a gitignored `<path>/.inscope`), `--servers <list>`, `--label`, the Slack options, `-y`.
- `inscope status` (`whoami`): show the identity resolved for the current directory, the Claude login (email + subscription, from `claude auth status`) and whether it is shared or isolated, the GitHub account and token, the git email, MCP servers, and skills. `--json` for scripting.
- `inscope list` (`ls`): show workspaces with their identity, servers, and skills.
- `inscope edit [path|label]`: change a workspace through the same prompts.
- `inscope rm [path|label]`: unmap a workspace (drops its git include, managed MCP servers, and skill links). Confirms by typing the label; `-y` skips it.

### Skills

- `inscope skill add <source>`: add skill(s). A source is a GitHub `owner/repo` (or a browser `tree`/`blob` URL), a git URL, or a local path, with an optional `#subdir`. A multi-skill source lists its skills to pick from. Flags: `-w/--workspace`, `-l/--list`, `-s/--skill <name>` (repeatable, `*` for all), `--all`, `-n/--name`, `--ref <branch|tag|sha>`, `-y`.
- `inscope skill list`: the workspace's skills and their link status.
- `inscope skill rename <old> <new>` (alias `mv`): rename a skill and its `/command`; re-links under the new name and prunes the old. Cannot rename the reserved `inscope` self-skill.
- `inscope skill rm <name>`: remove a skill. `rm inscope` opts out of the bundled self-skill; `add inscope` re-enables it.
- `inscope skill update`: pull the workspace's floating git skills.

### Checking

- `inscope doctor`: verify tokens, identities, the hook, and skill links resolve, each with its fix.
- `inscope diff`: preview what apply would change (hook, git includes, `.mcp.json`, skills). `--adopt` folds config-expressible on-disk `.mcp.json` settings back in; `--exit-code` gates CI.
- `inscope mcp`: run inscope itself as an MCP server over stdio (tools: `inscope_status`, `inscope_list`, `inscope_doctor`), so a client introspects identity without the CLI. Register with `claude mcp add inscope -- inscope mcp`.

## Recipes

- **Personal, work, client:** `inscope add ~/personal --gh personal-account --email you@personal.com` (shared login), `inscope add ~/work --gh work-account --email you@work.com --isolate` (its own login), `inscope add ~/clients/acme --isolate` (a client on its own login and subscription).
- **Who am I here:** `inscope status` (or `whoami`) prints the resolved Claude login and subscription, GitHub account, git email, MCP servers, and skills.
- **Skill in the current workspace:** `inscope skill add owner/repo#skills/the-skill`, or `inscope skill add owner/repo --list` to browse first.
- **Wrong account here:** run `inscope doctor` in the directory; it names the resolved workspace and whether its token and identity are present, says to run `inscope apply` if the hook is stale, then relaunch.
