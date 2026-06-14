# 05. Implementation roadmap

Phased delivery, the test plan, and the decisions that need a human before code.
Each phase is independently shippable and leaves inscope in a coherent state.

## Phasing

### Phase 1: the settings subtree generator (P1 surfaces)

Ships permissions, `enableAllProjectMcpServers`, model, env, outputStyle selection
(catalog 1, 2, 7, and the selection half of 8). One new generator, the schema's
per-workspace `claude.settings` field, no `profiles` yet.

- `src/config.ts`: bump `CONFIG_VERSION` to 2; add the optional `claude.settings`
  field to `Workspace`; extend `validateConfig` (types + injection-sensitive
  values). Per the existing pattern, validation lives at the write boundary
  (`saveConfig`, `config.ts:75`).
- `src/generators/claude-settings.ts`: `renderClaudeSettings`, `mergeClaudeSettings`,
  `applyClaudeSettings`, `removeClaudeSettings`, `preflightClaudeSettings`,
  `settingsLocalPath(ws)`. Mirror `mcp.ts` closely.
- `src/apply.ts`: preflight + apply per workspace; extend `ApplyResult`.
- `src/drift.ts`: `computeDrift` entry `claude-settings:<name>`.
- `src/doctor.ts`: per-workspace settings checks.
- `test/golden.test.ts`: `renderClaudeSettings` snapshots (all / permissions-only /
  empty).
- `bin/commands/`: `apply` / `diff` / `doctor` output lines; `add` / `edit` flags
  (`--model`, `--output-style`, `--trust-mcp`, a permissions preset). `list` shows
  the trust/model state.

Acceptance: `inscope add ~/acme --trust-mcp --model claude-opus-4-8` writes a
correct `settings.local.json`; `inscope diff` shows it; `inscope doctor` verifies
it; re-running apply is a no-op; `inscope rm` prunes the managed keys and leaves
the user's other keys intact.

### Phase 2: profiles and reuse

Ships `profiles` + `extends` and the `resolveClaude` merge so one "work" profile
serves many directories. Pure resolver, snapshot-tested. No new generator, just
the resolver feeding phase-1 render. Also a good point to add glob path rules
(`~/work/*`) since the hook already emits glob `case` patterns and resolves
longest-prefix (`hook.ts:4`, `doctor.ts:54`); that is a separable sub-proposal.

### Phase 3: the capability file generator (P2 surfaces)

Ships subagent / skill / command packs (catalog 3), the rules managed block
(catalog 4), and custom output-style files (catalog 8, file half).

- `~/.config/inscope/library/` layout and `inscope packs` / `library` command.
- `src/generators/claude-capabilities.ts`: `renderDesiredLinks`,
  `applyClaudeCapabilities`, `removeClaudeCapabilities`, symlink create/prune with
  the "link into the library = inscope-owned" rule.
- A Markdown-comment variant of `managed-block.ts` for the CLAUDE.md rules block
  (or `.claude/rules/` if confirmed).
- `computeDrift` `claude-caps:<name>` entry (link set diff); doctor dangling-link
  checks; golden snapshot of `renderDesiredLinks`.
- `add` / `edit` pack multiselect; `list` shows packs.

### Phase 4: hooks, identity status line, plugins (P3/P4)

Ships catalog 5, 6, 9 once the settings generator and the command-path validation
are proven. `inscope statusline` is the one genuinely new command and is the
highest-delight item here.

## Test plan

Follows the existing split (`test/golden.test.ts` for pinned artifacts,
`test/inscope.test.ts` for behavior):

- **Golden**: `renderClaudeSettings` (every key / permissions-only / empty),
  `renderDesiredLinks` (multi-pack / none), `resolveClaude` (profile + override
  precedence), the CLAUDE.md rules block render. Regenerate with
  `bun test --update-snapshots` and review the diff (`AGENTS.md`).
- **Behavior**: merge preserves unknown `settings.local.json` keys; remove deletes
  only managed keys; symlink prune leaves user-authored agents/skills; dangling
  link is a doctor `fail`; apply is idempotent; a v1 binary refuses a v2 config
  (the `configVersionError` guard); injection-sensitive values are rejected
  (statusLine/hook command inside the workspace, malformed permission entries).
- **Gates before commit** (`AGENTS.md`): `bun run format`, `bun run lint`,
  `bun run typecheck`, `bun run test`.

## Decisions that need a human (the AskUserQuestion list)

1. **Settings target: `settings.local.json` (recommended) vs `settings.json`.**
   The design assumes `settings.local.json` (gitignored, additive via array merge,
   never touches the committed file). Confirm this is the intended layer, or
   whether some keys (house permissions) should instead land in committed
   `settings.json` via a JSON-aware managed approach.
2. **Capability materialization: symlink (recommended) vs copy.** Symlinks are
   self-identifying (no manifest), edit-once-update-everywhere, and match the
   symlink-aware writer. Copy is portable and committable but needs a prune
   manifest. Could support both with symlink as default.
3. **Rules target: CLAUDE.md managed block (safe, confirmed) vs `.claude/rules/`
   (disputed existence, `02` section 7).** Default to the managed block; switch if
   `.claude/rules/` is confirmed on a live install.
4. **Config version bump to 2.** Confirm the forward-compat stance (a v1 binary
   should refuse a v2 config rather than silently drop the new artifacts).
5. **Scope phase 1 to settings only, or bundle profiles (phase 2) in?** Phase 1
   alone delivers 6 of 9 surfaces; profiles are pure ergonomics on top.
6. **Cross-platform.** Capability files (skills/agents) are OS-agnostic and could
   be inscope's first Linux-friendly feature, while the secret-resolving hook stays
   macOS/zsh. Decide whether phase 3 explicitly supports Linux or stays gated
   behind the existing platform warning (`doctor.ts:80`).

## Facts to verify on a live Claude Code before coding

Pulled from the **[verify]** flags in `02`:

- Exact per-server trust key: `enabledMcpjsonServers` vs `enabledMcpServers`
  (`enableAllProjectMcpServers` is agreed and safe to start with).
- `permissions.defaultMode` enum values.
- Whether `.claude/rules/` exists and its frontmatter (`paths:`).
- Hook `timeout` unit (ms vs s) and the full set of supported event names and
  `type`s.
- The precise `statusLine` stdin JSON field names (for `inscope statusline`).

A 20-minute session reading the current docs and one scratch project resolves all
of these. None block the design; they pin the exact bytes the generators emit,
which is what the golden snapshots will lock anyway.

## Why this stays "inscope" and not a second tool

Every phase reuses the existing generator contract, the two ownership patterns,
the atomic writer, the drift/doctor/snapshot loop, and the add/edit/apply CLI.
There is no new architectural concept, no new dependency, and no secret on disk.
inscope grows from "the right identity per directory" to "the right identity and
the right Claude Code setup per directory," which is the same promise applied to a
larger surface.
