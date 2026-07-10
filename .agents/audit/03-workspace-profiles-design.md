# 03. Design: workspace profiles

This is the core of the plan. Two new generators cover almost every surface in
`02`, both modeled on mechanisms inscope already ships. Then the config schema
evolution, the `apply` / `diff` / `doctor` / snapshot wiring, the security model,
and the open questions.

## The two mechanisms

| Mechanism | Surfaces it covers | Modeled on |
| --------- | ------------------ | ---------- |
| **A. Settings subtree** | permissions, model, env, outputStyle, statusLine, hooks, enableAllProjectMcpServers, enabledPlugins | `mergeMcpDoc` (namespaced-key JSON merge) |
| **B. Capability file set** | subagents, skills, slash commands, rules, output-style files | the per-workspace gitconfig dir (inscope-owned files materialized per workspace) |

Everything else (CLAUDE.md house rules) reuses Pattern A managed blocks
(`managed-block.ts`) directly, no new mechanism.

---

## Mechanism A: the settings subtree generator

New file `src/generators/claude-settings.ts`, structured exactly like `mcp.ts`.

### Where it writes, and why that solves the merge problem

inscope writes to **`.claude/settings.local.json`**, never `.claude/settings.json`.
This single choice removes the hardest problem (merging into a file a team also
edits) for three reasons:

1. `settings.local.json` is gitignored and machine-local: it is inscope's natural
   territory, the JSON analogue of the per-workspace gitconfig file it already
   owns.
2. Across scopes, **array keys concatenate** (`02`, precedence): inscope's
   `permissions.allow` in `settings.local.json` *adds to* the team's
   `settings.json` allow list. inscope augments; it never has to clobber.
3. For scalar keys (`model`, `outputStyle`), local overriding project is exactly
   the intended "this identity prefers Opus here" behavior.

### The merge, generalized from mcp.ts

`mergeMcpDoc` owns a *set of keys* in one object (`mcpServers`). The settings
merge owns a *fixed set of top-level keys* in the settings doc:

```ts
// the keys inscope manages; everything else in settings.local.json is the user's
const MANAGED_SETTING_KEYS = [
  "permissions", "model", "env", "outputStyle",
  "statusLine", "hooks", "enableAllProjectMcpServers", "enabledPlugins",
] as const

export const mergeClaudeSettings = (doc: Record<string, any>, ws: Workspace, cfg: Config) => {
  const next = { ...doc }                       // preserve the user's other keys
  for (const k of MANAGED_SETTING_KEYS) delete next[k]
  Object.assign(next, renderClaudeSettings(ws, cfg))   // rewrite exactly ours
  return next
}
```

Read it the same way as the mcp merge: "preserve the user's non-managed keys,
replace the keys inscope manages." `renderClaudeSettings(ws, cfg)` is the pure
function the golden snapshot pins. `applyClaudeSettings` / `removeClaudeSettings`
mirror `applyMcp` / `removeMcp` (read-or-throw, merge, `writeFileAtomic`); remove
deletes the managed keys and leaves the rest.

### A note on `permissions` granularity

Owning the whole `permissions` key in `settings.local.json` is the simplest
correct choice: inscope rewrites its own allow/deny/ask arrays there, and Claude
Code concatenates them with the team's `settings.json`. inscope does not need to
track which individual array entries are "its own" because it owns the entire key
*in that file*. If finer control is ever needed, the `--adopt` path (below) can
pull hand-added entries from `settings.local.json` back into config.

### Worked example

Config (the `claude.settings` block proposed under "Schema" below):

```jsonc
{
  "name": "acme",
  "claude": {
    "settings": {
      "permissions": {
        "allow": ["mcp__github-acme__*", "mcp__linear-acme__*", "Bash(bun run test:*)"],
        "deny": ["Bash(curl:*)", "Read(./.env*)"]
      },
      "model": "claude-opus-4-8",
      "enableAllProjectMcpServers": true,
      "outputStyle": "Explanatory"
    }
  }
}
```

Generated `~/acme/.claude/settings.local.json` (user's other keys preserved):

```json
{
  "permissions": {
    "allow": ["mcp__github-acme__*", "mcp__linear-acme__*", "Bash(bun run test:*)"],
    "deny": ["Bash(curl:*)", "Read(./.env*)"]
  },
  "model": "claude-opus-4-8",
  "enableAllProjectMcpServers": true,
  "outputStyle": "Explanatory"
}
```

Note how `enableAllProjectMcpServers: true` closes a real gap: inscope writes the
servers into `.mcp.json` today, but the user still approves them by hand; now the
same apply trusts exactly the servers inscope manages. inscope can derive the
allow entries from the workspace's own `servers` map, so the MCP allowlist stays
in sync automatically.

---

## Mechanism B: the capability file generator

New file `src/generators/claude-capabilities.ts`. This provisions the
file-per-capability surfaces (subagents, skills, slash commands, output-style
files, optionally rules) by materializing files from a central library into the
workspace's `.claude/`.

### The central library

A new directory `~/.config/inscope/library/`, sibling to the existing
`~/.config/inscope/git/`:

```
~/.config/inscope/library/
  agents/        ts-reviewer.md, security-auditor.md, ...
  skills/        changelog/SKILL.md, deploy/SKILL.md, ...
  commands/      pr.md, standup.md, ...
  output-styles/ diagrams-first.md, ...
```

These are authored once. A "pack" is a named bundle of references into the
library (see schema). A workspace selects packs; inscope materializes the union
of their files into `<workspace>/.claude/`.

### Materialize by symlink (default), self-identifying ownership

inscope links each selected file:

```
~/acme/.claude/agents/ts-reviewer.md -> ~/.config/inscope/library/agents/ts-reviewer.md
~/acme/.claude/skills/changelog      -> ~/.config/inscope/library/skills/changelog
```

Symlinks make ownership self-identifying and need no sidecar manifest: an entry in
`.claude/agents/` is inscope's if and only if it is a symlink whose target is
inside `~/.config/inscope/library/`. That is exactly enough to:

- **apply**: create links for the current pack set.
- **prune**: remove any inscope-owned link (link into the library) not in the
  current set, leaving the user's own committed agents/skills untouched.
- **doctor**: flag a dangling link (library file deleted) as a `fail`.

Symlinks also give edit-once-update-everywhere: fix `ts-reviewer.md` in the
library and every workspace sees it immediately, no re-apply needed. The atomic
writer is already symlink-aware (`io.ts:31`), so this fits the codebase ethos of
not inventing new state.

A `copy` mode is offered for users who want the files materialized as real files
(portable, survives a missing library, can be committed). Copy mode needs a
manifest to know what to prune, so symlink is the recommended default; see the
open decision in `05`.

### What the pure render function snapshots

The render function returns the desired link set as data, which the golden suite
pins (deterministic, sorted):

```ts
renderDesiredLinks(ws, cfg) => [
  { link: "~/acme/.claude/agents/ts-reviewer.md", target: "~/.config/inscope/library/agents/ts-reviewer.md" },
  { link: "~/acme/.claude/skills/changelog",      target: "~/.config/inscope/library/skills/changelog" },
]
```

`applyClaudeCapabilities(ws, cfg)` diffs desired against the on-disk
inscope-owned links and creates/prunes to match. Removing a workspace prunes all
its links (the `removeMcp` precedent).

---

## Config schema evolution

Bump `CONFIG_VERSION` to `2` (`config.ts:42`). Rationale: the new fields produce
new generated artifacts (`settings.local.json`, capability links) that a v1 binary
would not write, so a v1 binary running `apply` on a v2 config should refuse
rather than silently drop them. The existing guard (`configVersionError`,
`config.ts:131`) already does this: it rejects a config whose `version` exceeds
what the binary supports. A v2 binary still reads v1 configs (equal-or-older is
tolerated), so upgrade is seamless and downgrade is safe.

### Additions (all optional, back-compatible in shape)

Per-workspace `claude` object, plus top-level `profiles` and `packs`:

```jsonc
{
  "version": 2,

  // reusable bundles of library files
  "packs": {
    "house-rules":  { "rules": ["house-rules.md"] },               // CLAUDE.md block source
    "ts-review":    { "agents": ["ts-reviewer.md"], "commands": ["pr.md"], "skills": ["changelog"] }
  },

  // reusable settings + pack selections a workspace can extend
  "profiles": {
    "work": {
      "settings": { "permissions": { "deny": ["Bash(curl:*)"] }, "outputStyle": "Explanatory" },
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

      "extends": "work",            // inherit the "work" profile
      "claude": {                   // per-workspace overrides on top of the profile
        "settings": { "model": "claude-opus-4-8", "enableAllProjectMcpServers": true },
        "packs": ["deploy-runbook"] // added to the profile's packs
      }
    }
  ]
}
```

### Resolution order (effective config for a workspace)

`extends` profile, then per-workspace `claude`, deep-merged with the workspace
winning. Packs are the union of profile packs and workspace packs. The resolver is
a pure function `resolveClaude(ws, cfg) => { settings, packs }` so it is unit- and
snapshot-testable, and `renderClaudeSettings` / `renderDesiredLinks` consume its
output. Phase 1 can ship with only the per-workspace `claude` field and add
`profiles` / `extends` in phase 2 without a schema break (both are optional).

### Validation (extend `validateConfig`, `config.ts:142`)

Hand-rolled, no zod (memory: `inscope-zero-dependency`):

- `extends` names an existing profile; pack names in `profiles` / `claude` name
  existing `packs`; pack file references name existing files under
  `~/.config/inscope/library/<kind>/`.
- `settings.model` is a string; `permissions.{allow,deny,ask}` are string arrays;
  `outputStyle` is a string.
- **Injection-sensitive values** get the same hardening the hook values get
  (`hookValueError`, `gitValueError`, `config.ts:106-126`). A `statusLine.command`
  and hook `command` are executed by Claude Code, so validate they resolve to a
  path under the user's control (the library or `~/.config/inscope`), and reject a
  command path that points inside the workspace itself unless explicitly opted in
  (see Security). `permissions` rule strings are not shell-interpolated by inscope
  but should still be type-checked.

---

## Wiring into apply / diff / doctor / snapshots

The new generators slot into the existing orchestration with no structural change.

### apply (`src/apply.ts`)

```ts
// preflight: parse settings.local.json too, so a bad file aborts before any write
preflightMcp(cfg.workspaces)
preflightClaudeSettings(cfg.workspaces)   // new, mirrors preflightMcp

// ...existing hook / gitconfig / zshrc / mcp writes...

for (const ws of cfg.workspaces) {
  applyClaudeSettings(ws, cfg)            // new
  applyClaudeCapabilities(ws, cfg)        // new
}
```

Extend `ApplyResult` with `claudeSettings: string[]` and `capabilities: string[]`
and print them in `bin/commands/apply.ts` alongside the existing `hook` / `mcp`
lines.

### diff (`src/drift.ts`)

Add `computeDrift` entries per workspace:

- `claude-settings:<name>`: `current = readFileOrEmpty(settingsLocalPath)`,
  `next = serialized mergeClaudeSettings(...)`. Identical to the mcp drift entry,
  so the existing `diffLines` + colorizer (`diff.ts:15`) renders it unchanged.
- `claude-caps:<name>`: render desired vs actual link sets as sorted text and
  diff them, so a missing or stale link shows as a normal +/- diff.

Optionally extend `adoptable` (`drift.ts:129`): pull a hand-added
`permissions.allow` entry or a hand-set `model` from `settings.local.json` back
into the config, so `diff --adopt` round-trips settings the way it already does
for `.mcp.json`. This keeps the "your manual tweak is not silently dropped"
promise.

### doctor (`src/doctor.ts`)

Add to the per-workspace loop (`doctor.ts:144`):

- `settings.local.json` parses and equals the rendered target (warn "out of date;
  run `inscope diff`", mirroring the existing mcp content-drift check at
  `doctor.ts:216`).
- Each capability symlink resolves to an existing library file (fail on dangling).
- `outputStyle` names an existing style file (in the library or the workspace).
- A `statusLine` / hook command path exists and is executable.
- Library files referenced by selected packs exist.

Optionally add a "this shell" line to `liveSnapshot` (`doctor.ts:66`) showing the
effective model / active packs for `$PWD`.

### golden snapshots (`test/golden.test.ts`)

Add pure-render snapshots next to the existing ones (`renderMcp`, `renderHook`):

- `renderClaudeSettings`: all keys set; permissions-only; empty (no `claude`).
- `renderDesiredLinks`: a workspace pulling two packs; a workspace with none.
- `resolveClaude`: profile + override merge precedence.

These follow the exact pattern at `golden.test.ts:70-108` and are reviewed via
`bun test --update-snapshots` per `AGENTS.md`.

### CLI (`bin/commands/`)

- `add` / `edit`: a new optional prompt step "Claude Code profile / packs"
  (`selectOne` for profile, `selectMany` for packs from the library) and a
  permissions preset picker. All skippable with flags and `-y`, matching the
  existing server multiselect (`add.ts:168`). New flags: `--profile`, `--packs`,
  `--model`, `--output-style`, `--trust-mcp`.
- `list`: show the profile and packs per workspace.
- New `inscope packs` (alias `library`): list available packs and the files each
  resolves to, and validate the library.
- New `inscope statusline`: the command users point `statusLine.command` at; reads
  the stdin JSON (`02`, section 9), resolves the workspace from `cwd` via
  `currentWorkspace`, and prints `acme | neeraj@acme.org | 3 servers`.

---

## Security model

Three of these surfaces execute or gate code, so provenance matters. This is
where the design is not just additive but a genuine improvement on the default
trust model, and it is on-brand with inscope's "you are the right person in this
directory" thesis.

- **Permissions** gate tool use. inscope writing a conservative per-identity deny
  list (no `curl`, no reading `.env`) into a prod-credentialed workspace is a
  safety win that the directory itself cannot opt out of, because it lives in the
  machine-local `settings.local.json`, not the repo.
- **Hooks and statusLine execute commands.** The key property: inscope points them
  at the **central library under the user's control**, not at a path inside the
  cloned repo. A repository you check out therefore cannot smuggle in a
  `PreToolUse` hook that runs on your machine, because inscope refuses to wire a
  hook/statusline command whose path is inside the workspace (validated in
  `validateConfig`). Provenance-from-a-trusted-library is a feature.
- **settings.local.json is gitignored**, so anything inscope writes there
  (permission grants, model pins) is never accidentally committed, consistent with
  inscope's "nothing leaks where it should not" posture.
- **Capability files are symlinks into the library**, so what a workspace runs is
  always traceable to a file the user authored, not an opaque copy.

---

## What this deliberately does not do

- It does not edit a team's committed `.claude/settings.json`, `CLAUDE.md` (except
  inside an explicit managed block), or any repo-committed skill/agent. inscope
  owns its `settings.local.json` keys, its managed block, and its own symlinks,
  and nothing else. The "own only your block" invariant (`01`) is preserved.
- It does not store secrets in the new fields. API keys belong in the live-resolved
  hook env (a separate proposal), not in `settings`.
- It does not try to provision enterprise/managed settings or keybindings (`02`,
  out of scope).
