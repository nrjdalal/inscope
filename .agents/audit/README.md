# inscope: workspace capability provisioning (design audit)

This directory is an intensive research and design plan for growing inscope from
a per-workspace **identity** manager (gh token + git email + MCP servers) into a
per-workspace **profile** manager that also provisions the rest of Claude Code's
project-level config surface: permissions, hooks, status line, output style,
subagents, skills, slash commands, and project rules.

It is a plan, not an implementation. Nothing here has been built. Every proposal
is grounded in the current code (file and line references throughout) and in the
current Claude Code config surfaces (verified against docs.claude.com, with the
points of uncertainty flagged so they get confirmed before any code is written).

## The thesis in one sentence

inscope already owns the hard part of provisioning any project-level config file
(resolve the workspace from `$PWD`, write only the block it owns, keep it
idempotent, expose it through `diff` / `doctor` / `apply`), so `.mcp.json` is
just the first of roughly a dozen surfaces the same machinery can drive.

## Reading order

1. [`01-architecture-audit.md`](./01-architecture-audit.md) - what inscope is
   today: the generator contract, the two ownership patterns, the invariants any
   new surface must preserve. Read this first; the design depends on it.
2. [`02-claude-code-surfaces.md`](./02-claude-code-surfaces.md) - the full
   project-level Claude Code config surface, each with a verified example and a
   note on where it lives and how it merges.
3. [`03-workspace-profiles-design.md`](./03-workspace-profiles-design.md) - the
   design: two new generators (a settings subtree, a capability file set), the
   config schema evolution, and the `apply` / `diff` / `doctor` / snapshot
   wiring. The core of the plan.
4. [`04-surface-catalog.md`](./04-surface-catalog.md) - one entry per surface:
   config in, generated artifact out, effort, risk, priority. The "what gets
   built" table with worked examples.
5. [`05-implementation-roadmap.md`](./05-implementation-roadmap.md) - phased
   delivery, the test plan, and the decisions that need a human before code.

## The recommendation, up front

Build in three phases, smallest-leverage-first:

| Phase | Ships | Unlocks |
| ----- | ----- | ------- |
| 1 | `.claude/settings.local.json` managed by a new `claude-settings` generator | per-workspace **permissions**, `enableAllProjectMcpServers` (auto-trust inscope's own servers), `model`, `outputStyle`, `statusLine`, `env`, `hooks` |
| 2 | `profiles` + `extends` in the config | reuse one "work" profile across many directories instead of repeating it |
| 3 | A `claude-capabilities` generator that links library files into `.claude/` | per-workspace **subagent / skill / slash-command / rules packs** |

Phase 1 is one new generator that follows `src/generators/mcp.ts` almost exactly,
and it alone delivers six of the nine surfaces in the catalog. Phase 3 is the
headline capability (the "skills" the request started from) and needs the second,
file-set mechanism.

## Why this fits inscope and does not bloat it

- It reuses the existing generator contract verbatim (pure render, snapshot
  pinned, paired apply/remove). No new architectural concept.
- It keeps the config secret-free: permissions, pack names, and model ids are not
  secrets, so the committed-shareable nature of `inscope.json` is preserved.
- It targets `.claude/settings.local.json` (gitignored, machine-local), so it
  never edits a team's committed `.claude/settings.json`. The "own only your
  block, never clobber the user" invariant holds unchanged.
- It stays zero-dependency: JSON merge and symlink management are a few dozen
  lines of `node:fs`, exactly like the current generators.

See `05-implementation-roadmap.md` for the open decisions (settings.local vs
settings, symlink vs copy, rules-via-CLAUDE.md vs rules-dir, whether capabilities
should finally take inscope cross-platform).
