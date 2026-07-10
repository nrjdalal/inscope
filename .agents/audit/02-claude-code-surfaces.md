# 02. Claude Code project-level config surfaces

The full set of configuration surfaces Claude Code reads from inside a project
directory (not the user-global `~/.claude`). Each entry: where it lives, what it
does, a verified minimal example, and how it merges with user-level config. This
is the menu the design in `03` provisions from.

Verified against docs.claude.com / code.claude.com/docs. Two independent
verification passes disagreed on a handful of exact key names; every such point
is called out inline as **[verify]** so it is confirmed against a live install
before any code depends on it.

## Precedence (highest to lowest)

1. Managed / enterprise settings (IT-deployed; no project equivalent)
2. Command-line flags
3. `.claude/settings.local.json` (project, machine-local, gitignored)
4. `.claude/settings.json` (project, committed, team-shared)
5. `~/.claude/settings.json` (user)

Important merge rule: across scopes, **arrays concatenate** (e.g. `permissions.allow`
from local + project + user all apply) and **objects merge recursively** with the
higher scope's leaf values winning. This rule is the linchpin of the design: it
lets inscope write to `settings.local.json` and *add to* a team's committed
`settings.json` without ever editing the committed file.

## 1. `.mcp.json` (already managed by inscope)

Project MCP servers. Merges with `~/.mcp.json`; project wins on a name clash.

```json
{
  "mcpServers": {
    "github-acme": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

This is the surface inscope owns today via the namespaced-key pattern.

## 2. `.claude/settings.json` and `.claude/settings.local.json`

JSON. `settings.json` is committed (team); `settings.local.json` is gitignored
(machine-local). Notable keys, with value shapes:

```json
{
  "permissions": {
    "defaultMode": "ask",
    "allow": ["Bash(bun run test:*)", "Read(src/**)", "mcp__linear-acme__*"],
    "deny": ["Bash(rm -rf *)", "Read(./.env*)", "Bash(curl:*)"],
    "ask": ["Bash(git push:*)"]
  },
  "model": "claude-opus-4-8",
  "env": { "FOO": "bar" },
  "outputStyle": "Explanatory",
  "statusLine": { "type": "command", "command": "inscope statusline" },
  "hooks": { "PreToolUse": [ /* see section 5 */ ] },
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["github-acme", "linear-acme"],
  "disabledMcpjsonServers": [],
  "enabledPlugins": { "some-plugin@marketplace": true },
  "includeCoAuthoredBy": false,
  "cleanupPeriodDays": 30,
  "additionalDirectories": ["../shared-lib"]
}
```

Key notes and flags:

- `permissions.allow` / `deny` / `ask`: arrays of rule strings. Rule grammar is
  `Tool(specifier)`, e.g. `Bash(npm run test:*)`, `Read(./.env*)`, or an MCP tool
  `mcp__<server>__<tool>` (and `mcp__<server>__*` for a whole server). Because
  inscope names servers `<type>-<label>`, the MCP rules it would write are
  `mcp__github-acme__*`, which dovetails with the existing naming.
- `permissions.defaultMode`: one of `ask`, `acceptEdits`, `plan`, `bypassPermissions`
  (and possibly `auto` / `deny`). **[verify]** the exact enum.
- `enableAllProjectMcpServers` (boolean): auto-trust every server in `.mcp.json`.
  Both verification passes agree on this name.
- The per-server allowlist key is **[verify]**: one pass reported
  `enabledMcpjsonServers` / `disabledMcpjsonServers`, the other `enabledMcpServers`.
  Confirm against a live `claude` before using. `enableAllProjectMcpServers` is
  the safe, agreed mechanism to start with.
- `statusLine`: `{ "type": "command", "command": "<shell command>" }`. The command
  receives a JSON context on **stdin** (cwd, model, workspace, git, cost, context
  window), not argv. See section 8.
- `includeCoAuthoredBy`: legacy boolean. inscope sets nothing about commit
  authorship by default; if it ever did, note the repo rule against co-author
  trailers (`AGENTS.md`).
- Hot reload: most keys reload live; `model` and `outputStyle` need `/model` or
  `/clear` to take effect mid-session.

## 3. Subagents: `.claude/agents/<name>.md`

Markdown with YAML frontmatter; the body is the subagent's system prompt.

```markdown
---
name: ts-reviewer
description: Reviews TypeScript diffs for correctness and reuse. Use after edits.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a senior TypeScript reviewer. Focus on correctness bugs first, then
reuse and simplification. Be concise.
```

- `tools` accepts a comma/space-separated string or a YAML list. Omit it to
  inherit the full tool set.
- `model`: `sonnet` / `opus` / `haiku` / `fable`, a full id like `claude-opus-4-8`,
  or `inherit`.
- Project agents override user agents of the same `name`. Identity is the `name`
  field, not the filename, though convention is to match them.

## 4. Agent Skills: `.claude/skills/<name>/SKILL.md`

A directory per skill; `SKILL.md` plus any supporting files it references.

```markdown
---
name: changelog
description: Draft a changelog entry from the staged diff
allowed-tools: Read, Bash(git diff:*)
argument-hint: [version]
---

Draft a Conventional-Commit changelog line for $ARGUMENTS from:

!`git diff --staged`

Keep it to one line. See [style.md](style.md) for the house format.
```

- The invocation name comes from the **directory name**, not the `name` field.
- `disable-model-invocation: true` makes it user-only (`/changelog`); otherwise
  Claude may auto-invoke based on `description`.
- `` !`cmd` `` lines are preprocessed: the command runs and its output is spliced
  into the prompt before Claude sees it. Substitutions: `$ARGUMENTS`, `$1`,
  `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`.
- Supporting files in the skill dir are loaded on demand when referenced, not
  eagerly.

## 5. Hooks (declared in `settings.json` under `hooks`)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "~/.config/inscope/hooks/guard-push.sh", "timeout": 5000 }
        ]
      }
    ]
  }
}
```

- Confirmed event names: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
  `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`, `Notification`,
  `PreCompact`. Other names surfaced in one pass (`FileChanged`, `PermissionRequest`,
  and more) are **[verify]**.
- `matcher` matches a tool name (`"Bash"`, `"Edit|Write"`); some events take no
  matcher and always fire.
- `type`: `command` (script; receives hook JSON on stdin, exit 2 blocks), and also
  `http` / `prompt` / `agent` / `mcp_tool` in newer builds. **[verify]** the
  `timeout` unit (ms vs s); passes disagreed. Treat as **[verify]**.
- **Security**: a `command` hook executes code on tool calls. Where the command
  path comes from matters: see the trust argument in `03`.

## 6. Project memory: `CLAUDE.md` / `AGENTS.md` / `CLAUDE.local.md`

Markdown, loaded into context at session start (and concatenated across scopes,
they do not override one another). `CLAUDE.local.md` is gitignored and loaded
last. Supports `@path/to/file` imports. This repo's own `CLAUDE.md` is a symlink
to `AGENTS.md`, which is the convention inscope itself follows.

```markdown
<!-- >>> inscope:rules >>> -->
## House rules
- Never use em-dashes in prose.
- Conventional, scoped commit titles.
<!-- <<< inscope:rules <<< -->
```

The HTML-comment markers above show how the existing managed-block pattern
(`managed-block.ts`, currently `#`-style for shell/git) extends to Markdown.

## 7. Project rules: `.claude/rules/<name>.md` **[verify: feature existence]**

One verification pass described a `.claude/rules/` directory: Markdown files with
optional `paths:` frontmatter (a glob array) so a rule loads only when Claude
touches a matching file; rules without `paths` load at startup like `CLAUDE.md`.
The other pass reported this directory **does not currently exist** and that
path-scoped rules live in skill/agent frontmatter or in `CLAUDE.md` sections.

```markdown
---
paths: ["src/**/*.ts", "**/*.test.ts"]
---
- Use `@/` for src imports and `~/` for repo-root imports.
```

Because the feature's existence is disputed, the design treats **rules as a
CLAUDE.md managed block** (Pattern A, definitely supported) as the default, and
the `.claude/rules/` directory as an optional target to enable once confirmed.

## 8. Output styles: `.claude/output-styles/<name>.md`

Markdown with frontmatter; modifies the system prompt. Selected by the
`outputStyle` settings key (section 2). Needs `/clear` to apply.

```markdown
---
name: Diagrams first
description: Lead explanations with a Mermaid diagram
keep-coding-instructions: true
---

Start every explanation with a Mermaid diagram, then prose.
```

## 9. Status line: `statusLine` in settings (section 2)

The command receives a JSON context on stdin and prints one line. Shape of the
stdin payload (fields may be null early in a session):

```json
{
  "cwd": "/Users/me/acme/api",
  "model": { "id": "claude-opus-4-8", "display_name": "Opus" },
  "workspace": { "project_dir": "/Users/me/acme/api", "repo": { "owner": "acme", "name": "api" } },
  "context_window": { "used_percentage": 7.75 },
  "cost": { "total_cost_usd": 0.012 }
}
```

This is the natural home for an inscope-aware status line that shows the resolved
identity (`acme | neeraj@acme.org | 3 servers`), since inscope already knows the
mapping from `cwd`. See `04`, surface 6.

## 10. Plugins (`enabledPlugins` in settings)

A plugin bundles skills, agents, commands, hooks, MCP servers, output styles, and
settings, and is enabled per project via `enabledPlugins` (object keyed by
`<plugin>@<marketplace>`). inscope could enable a fixed plugin set per profile;
this is the lowest-priority surface (it is mostly a single settings key) and is
covered briefly in `04`.

## What has no project-level equivalent (out of scope)

Managed/enterprise settings, managed `CLAUDE.md`, keybindings
(`~/.claude/keybindings.json`), and organization policies are user-global or
IT-deployed only. inscope should not try to provision these.
