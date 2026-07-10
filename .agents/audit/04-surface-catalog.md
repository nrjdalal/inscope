# 04. Surface catalog

One entry per surface inscope could provision: the value, the config input, the
generated output, the mechanism (A = settings subtree, B = capability files, MB =
managed block), effort, risk, and priority. Effort is relative to "add one
generator that mirrors `mcp.ts`."

## Summary table

| # | Surface | Mechanism | Effort | Risk | Priority |
| - | ------- | --------- | ------ | ---- | -------- |
| 1 | Permissions | A | S | low | **P1** |
| 2 | Trust own MCP servers (`enableAllProjectMcpServers`) | A | XS | low | **P1** |
| 3 | Subagent / skill / command packs | B | M | med | **P2** |
| 4 | Project rules (CLAUDE.md house rules) | MB | S | low | **P2** |
| 5 | Hooks | A | M | med (executes code) | P3 |
| 6 | Status line (identity-aware) | A + new cmd | S | low | P3 |
| 7 | Model / env per workspace | A | XS | low | P1 (rides #1) |
| 8 | Output style | A + B | S | low | P3 |
| 9 | Plugins (`enabledPlugins`) | A | XS | low | P4 |

P1 surfaces (1, 2, 7) all ship from the single phase-1 settings generator.

---

## 1. Permissions (P1)

**Value.** The most identity-shaped surface. A prod-credentialed work repo denies
dangerous bash and gates pushes; a scratch repo allows-all. inscope already knows
"this is the acme workspace," so attaching a permission profile is the natural
next step.

**Config in:**

```jsonc
"claude": { "settings": { "permissions": {
  "allow": ["Bash(bun run test:*)", "mcp__github-acme__*"],
  "deny":  ["Bash(curl:*)", "Read(./.env*)", "Bash(rm -rf:*)"],
  "ask":   ["Bash(git push:*)"],
  "defaultMode": "ask"
}}}
```

**Generated `~/acme/.claude/settings.local.json`:** the `permissions` object
verbatim, concatenated by Claude Code with the team's committed allow/deny.

**Mechanism A.** Risk low (settings.local.json is additive and gitignored).

## 2. Trust inscope's own MCP servers (P1)

**Value.** Closes an existing gap: inscope writes `.mcp.json` servers today but the
user still approves them by hand on first launch.

**Config in:** `"claude": { "settings": { "enableAllProjectMcpServers": true } }`,
or finer-grained, derive `enabledMcpjsonServers` from the workspace's `servers`
map automatically so only inscope-managed servers are trusted. **[verify]** the
exact per-server key name (`02`, section 2).

**Generated:** `{ "enableAllProjectMcpServers": true }` in `settings.local.json`.

**Mechanism A.** Effort XS once #1's generator exists; risk low.

## 3. Subagent / skill / command packs (P2, the headline)

**Value.** The "workspace skills" the request started from. Author a subagent,
skill, or slash command once in the central library, group them into a pack, and
inscope materializes the pack into every workspace that selects it, kept in sync.

**Config in:**

```jsonc
"packs": {
  "ts-review": { "agents": ["ts-reviewer.md"], "skills": ["changelog"], "commands": ["pr.md"] }
},
"workspaces": [ { "name": "acme", "claude": { "packs": ["ts-review"] } } ]
```

**Library file (authored once), `~/.config/inscope/library/agents/ts-reviewer.md`:**

```markdown
---
name: ts-reviewer
description: Reviews TypeScript diffs for correctness and reuse. Use after edits.
tools: Read, Grep, Glob, Bash
model: sonnet
---
You are a senior TypeScript reviewer. Correctness bugs first, then reuse.
```

**Generated (symlinks):**

```
~/acme/.claude/agents/ts-reviewer.md -> ~/.config/inscope/library/agents/ts-reviewer.md
~/acme/.claude/skills/changelog      -> ~/.config/inscope/library/skills/changelog
~/acme/.claude/commands/pr.md        -> ~/.config/inscope/library/commands/pr.md
```

**Mechanism B.** Effort M (new file-set generator); risk med (collision and prune
logic, handled by the symlink self-identification in `03`).

## 4. Project rules / house rules (P2)

**Value.** Org conventions ("never use em-dashes", import aliases, commit style)
injected into every workspace's project memory, edited in one place.

**Config in:** `"packs": { "house-rules": { "rules": ["house-rules.md"] } }`.

**Generated.** Default target is a managed block in `<workspace>/CLAUDE.md`
(Pattern A with Markdown/HTML-comment markers), because the `.claude/rules/`
directory's existence is disputed (`02`, section 7). The block id reuses
`managed-block.ts` with a Markdown comment variant:

```markdown
<!-- >>> inscope:rules >>> -->
- Never use em-dashes in prose.
- Use `@/` for src imports, `~/` for repo-root imports.
- Conventional, scoped commit titles.
<!-- <<< inscope:rules <<< -->
```

If `.claude/rules/` is confirmed, switch to symlinking rule files under it
(Mechanism B), which also gives `paths:` scoping. Risk low.

## 5. Hooks (P3)

**Value.** A work profile installs a `PreToolUse` hook that blocks force-push to
prod, or a `SessionStart` hook that runs `inscope doctor`.

**Config in:**

```jsonc
"claude": { "settings": { "hooks": {
  "PreToolUse": [ { "matcher": "Bash", "hooks": [
    { "type": "command", "command": "~/.config/inscope/library/hooks/guard-push.sh", "timeout": 5000 }
  ]}]
}}}
```

**Generated:** the `hooks` object in `settings.local.json` (Mechanism A), with the
command path validated to live under the user's library, not inside the repo
(`03`, Security). Effort M; risk med because it executes code, which is exactly
why the trusted-provenance rule matters. Ship after #1 lands and the validation is
in place.

## 6. Identity-aware status line (P3)

**Value.** inscope is about per-directory identity; this makes that identity
visible at all times. A delightful, low-risk synergy.

**Config in:** `"claude": { "settings": { "statusLine": { "type": "command", "command": "inscope statusline" } } }`.

**New command `inscope statusline`:** reads the stdin JSON (`02`, section 9),
resolves the workspace from `cwd` via `currentWorkspace(cfg)` (`doctor.ts:46`,
already exists), and prints:

```
acme | neeraj@acme.org | 3 servers | opus
```

**Mechanism A** for the settings key, plus a thin new command. Effort S; risk low.

## 7. Model / env per workspace (P1, rides #1)

**Value.** Pin a default model per identity ("Opus in the work monorepo"), set
Claude-Code-specific env. Distinct from the shell-hook env (which carries
secrets); this is the non-secret `env` block Claude reads directly.

**Config in:** `"claude": { "settings": { "model": "claude-opus-4-8", "env": { "FOO": "bar" } } }`.

**Generated:** `{ "model": "...", "env": { ... } }` in `settings.local.json`.
Mechanism A, effort XS. Use the canonical model ids from the Claude API reference.

## 8. Output style (P3)

**Value.** Terse/Proactive for a work repo, Explanatory for a learning repo.

**Two parts.** The selection is a settings key (`"outputStyle": "Explanatory"`,
Mechanism A). A *custom* style file is a library file linked into
`.claude/output-styles/` (Mechanism B). Built-in styles need only the settings
key. Effort S; risk low.

## 9. Plugins (P4)

**Value.** Enable a fixed plugin set per profile (all acme repos get the
acme-internal plugin).

**Config in:** `"claude": { "settings": { "enabledPlugins": { "acme-internal@acme-mp": true } } }`.

**Generated:** the `enabledPlugins` object in `settings.local.json`. Mechanism A,
effort XS, lowest priority (it is essentially one passthrough key).

---

## What a fully-configured workspace looks like end to end

Config (`~/.config/inscope/inscope.json`):

```jsonc
{
  "version": 2,
  "packs": {
    "house-rules": { "rules": ["house-rules.md"] },
    "ts-review":   { "agents": ["ts-reviewer.md"], "skills": ["changelog"], "commands": ["pr.md"] }
  },
  "profiles": {
    "work": {
      "settings": {
        "permissions": { "deny": ["Bash(curl:*)", "Read(./.env*)"], "defaultMode": "ask" },
        "outputStyle": "Explanatory"
      },
      "packs": ["house-rules", "ts-review"]
    }
  },
  "workspaces": [
    {
      "name": "acme",
      "path": "~/acme",
      "gh": "neeraj-acme-org",
      "git": { "email": "neeraj@acme.org" },
      "servers": { "github": true, "linear": true },
      "extends": "work",
      "claude": { "settings": { "model": "claude-opus-4-8", "enableAllProjectMcpServers": true } }
    }
  ]
}
```

Generated artifacts for `~/acme` after `inscope apply`:

```
~/acme/.mcp.json                          (github-acme, linear-acme)          [today]
~/acme/.claude/settings.local.json        permissions + model + trust-mcp     [new, A]
~/acme/.claude/agents/ts-reviewer.md  ->  library/agents/ts-reviewer.md       [new, B]
~/acme/.claude/skills/changelog       ->  library/skills/changelog            [new, B]
~/acme/.claude/commands/pr.md         ->  library/commands/pr.md              [new, B]
~/acme/CLAUDE.md                          inscope:rules managed block         [new, MB]
~/.gitconfig                              includeIf -> git/acme.gitconfig     [today]
~/.config/inscope/inscope.zsh             chpwd hook (GITHUB_TOKEN per $PWD)  [today]
```

`cd ~/acme` and you are the work identity (gh token, commit email), with the work
MCP servers already trusted, the work permission floor, the work model, the work
review subagent and skills, and the house rules in context. One `inscope add`,
one source of truth.
