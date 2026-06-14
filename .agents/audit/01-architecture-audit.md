# 01. Architecture audit: what inscope is today

Before proposing new surfaces, this is a precise read of the current code, so the
design in `03` extends real seams rather than imagined ones. Every claim points
at a file and, where useful, a line.

## The data model

One config file, `~/.config/inscope/inscope.json`, is the single source of truth
(`src/env.ts:26`, `configPath`). Its shape (`src/config.ts:29-47`):

```ts
type Workspace = {
  name: string                       // a slug: [A-Za-z0-9._-]+  (config.ts:88)
  path: string                       // tilde-contracted, e.g. "~/acme"
  gh?: string                        // gh account whose token this dir uses
  git?: { email?: string; name?: string }
  servers: Servers                   // the MCP server map
}
type Config = { version: number; workspaces: Workspace[] }
```

`CONFIG_VERSION` is `1` (`config.ts:42`). The forward-compat guard
(`configVersionError`, `config.ts:131`) refuses a config whose `version` is
strictly greater than the binary supports, but tolerates equal-or-older. That is
the lever for evolving the schema safely (see `03`).

Everything sensitive is resolved live and never written to disk: the GitHub token
comes from the `gh` keyring and the Slack token from the macOS Keychain, both
pulled at `cd` time by the generated zsh hook. The config therefore contains no
secrets, which is what makes it safe to commit and share.

## The generator contract

There are three generators, each in `src/generators/`, and each follows the same
two-part contract:

1. A **pure render** function: config in, text (or a plain object) out, with the
   same input always producing the same output. These are what the golden
   snapshot suite pins.
2. A **side-effecting apply / remove** pair that reads the on-disk file, splices
   in (or removes) only what inscope owns, and writes atomically.

| Generator | Pure render | Apply / remove | Output file |
| --------- | ----------- | -------------- | ----------- |
| `hook.ts` | `renderHook(cfg)` (`:22`) | written by `applyAll` (`apply.ts:57`) | `~/.config/inscope/inscope.zsh` |
| `mcp.ts` | `renderMcp(ws)` / `renderServers(ws)` (`:91`, `:56`) | `applyMcp` / `removeMcp` (`:142`, `:147`) | `<workspace>/.mcp.json` |
| `gitconfig.ts` | `renderGitInclude(cfg)` / `renderPerWorkspaceGitconfig(ws)` (`:18`, `:29`) | `applyGitconfig` (`:36`) | `~/.gitconfig` block + `~/.config/inscope/git/<name>.gitconfig` |

The render functions stay pure precisely so `test/golden.test.ts` can lock their
exact output; the snapshot diff is the review surface for any change to generated
bytes (`AGENTS.md`, "ALWAYS regenerate the golden snapshots"). A new surface that
respects this contract gets reviewability for free.

## The two ownership patterns

inscope writes into files it does not solely own without ever clobbering the
user's content. It does this two different ways, and which one a surface uses is
the single most important design choice for any new generator.

### Pattern A: marked managed block (for line-based dotfiles)

`src/managed-block.ts` wraps inscope's content in sentinel comments:

```
# >>> inscope:<id> >>>
...managed content...
# <<< inscope:<id> <<<
```

`upsertBlock` / `removeBlock` / `readBlock` (`managed-block.ts:16,30,40`) splice
that block in or out by regex, leaving everything outside it untouched. Used for
`~/.zshrc` (the source line is actually a single idempotent appended line, see
`apply.ts:27`) and the `~/.gitconfig` includeIf block (`gitconfig.ts:48-53`,
block id `"gitconfig"`).

This pattern needs a comment syntax, so it suits `.zshrc`, `.gitconfig`,
`CLAUDE.md` (Markdown / HTML comments), but **not JSON** (`.mcp.json`,
`settings.json`), which has no comments.

### Pattern B: namespaced keys (for JSON inscope shares)

For `.mcp.json`, inscope cannot use comment markers, so it owns specific **keys**
instead. `managedKeys(name)` (`mcp.ts:49`) is `["github-<name>", "linear-<name>",
...]`: every server name is suffixed with the workspace label, so servers from
different workspaces never collide and inscope can identify exactly which keys are
its own. `mergeMcpDoc` (`mcp.ts:124`) is the whole pattern in five lines:

```ts
const servers = { ...doc.mcpServers }          // keep the user's keys
for (const key of managedKeys(ws.name)) delete servers[key]   // drop ours
Object.assign(servers, renderServers(ws))      // rewrite ours
return { ...doc, mcpServers: servers }          // preserve every other top-level key
```

Read it as: "preserve the user's non-managed keys, replace the keys inscope
manages." `applyMcp` and `diff`'s `mcpTarget` (`drift.ts:29`) both route through
this one function, which is what makes the diff provably the bytes apply will
write. **This is the pattern the new settings generator generalizes** (see `03`).

## Whole files inscope owns outright

A third, simpler case: files inscope creates and owns completely (no user content
to preserve) are written directly through the atomic writer. The hook
(`inscope.zsh`), each per-workspace gitconfig (`git/<name>.gitconfig`), and
`inscope.json` itself are in this bucket (`CONTRIBUTING.md`, Architecture). The
per-workspace gitconfig dir (`~/.config/inscope/git/`) is the precedent for the
"central library of inscope-owned files materialized per workspace" idea in `03`.

## The atomic writer

Every write goes through `writeFileAtomic` (`src/io.ts:29`): write a sibling temp
file, then `rename(2)` over the target. Three properties matter for new surfaces:

- **Crash- and race-safe**: a concurrent inscope, a SIGINT, or a full disk can
  never leave a half-written file; a reader sees the old bytes or the new bytes.
- **Symlink-aware** (`io.ts:31-35`): it resolves the real path first and writes
  through the link, so a chezmoi/stow-managed dotfile keeps its symlink. This is
  why the capability-file mechanism in `03` can lean on symlinks.
- **Mode-preserving** (`io.ts:41-47`): it copies the target's permission bits, so
  a `0600` file is not silently widened.

## How a full apply runs

`applyAll(cfg)` (`apply.ts:50`):

1. `preflightMcp` parses every workspace's `.mcp.json` before any write, so one
   unparseable file aborts the whole apply rather than half-applying (`apply.ts:54`,
   `mcp.ts:138`). Any new file-format surface should join this preflight.
2. Write the hook, then `applyGitconfig`, then `ensureZshrcSource`, then
   `applyMcp` per workspace (`apply.ts:57-66`).
3. Return an `ApplyResult { hook, gitconfig, mcp[] }` the CLI prints
   (`apply.ts:44`, `bin/commands/apply.ts:36`).

`persist(ws)` in `bin/commands/_workspace.ts:51` is the add/edit path: save the
config, `applyAll`, and prune the old path's managed block if the workspace
moved. New surfaces ride this for free since they hang off `applyAll`.

## How drift, diff, and adopt work

`computeDrift(cfg)` (`drift.ts:49`) returns one `Drift { label, path, current,
next, error? }` per managed artifact, filtered to those that actually differ
(`drift.ts:88`). `diff` colorizes `diffLines(current, next)` (a small LCS line
diff, `drift.ts:92`) in GitHub's dark palette (`bin/commands/diff.ts:15`).
`--exit-code` turns drift into a non-zero exit for CI gates (`diff.ts:93`).

`adoptable(cfg)` (`drift.ts:129`) is the back-sync: settings present in an on-disk
`.mcp.json` that the config could express but does not yet (a Slack add-message
tool, a custom server URL), returned as a patched config plus a human-readable
change list. `diff --adopt` writes them back so the next apply keeps them
(`diff.ts:70-82`). New surfaces that can drift in user-meaningful ways should add
both a `computeDrift` entry and, where round-tripping makes sense, an `adoptable`
rule.

## How doctor verifies

`runDoctor(cfg)` (`doctor.ts:77`) returns `Check { status, label, detail }[]`
(`status` is `ok | warn | fail`). It checks platform and shell, then the hook is
current, `.zshrc` sources it, the gitconfig block is present, and then loops every
workspace checking: the gh token resolves, the Slack keychain entry exists, the
per-workspace git email matches, the `.mcp.json` parses and is current, and no MCP
server is left unpinned (`doctor.ts:144-233`). `currentWorkspace(cfg)`
(`doctor.ts:46`) resolves which workspace `$PWD` is in by longest-prefix, mirroring
the hook's most-specific-first `case` order. A new surface adds checks to the
per-workspace loop and, optionally, a "this shell" line to `liveSnapshot`.

## The CLI surface

`bin/index.ts` is a flat command switch (`:44`). Commands live in `bin/commands/`,
share prompt helpers in `_prompt.ts` (`selectOne`, `selectMany`, `promptText`,
`promptConfirm`, `promptHidden`, plus the `orange` / `green` / `red` / `yellow`
output styling), and share workspace helpers in `_workspace.ts` (`persist`,
`buildServers`, `enabledServers`, `finalizeSlack`). `bin/` is the CLI surface only;
logic belongs in `src/` (`AGENTS.md`). A new surface that needs prompts extends
`add` / `edit` and adds `src/` logic, not bin logic.

## The invariants any new surface must preserve

These are the load-bearing constraints. The design in `03` is shaped by them.

1. **Zero runtime dependencies.** Validation is hand-rolled; no zod (memory:
   `inscope-zero-dependency`). New parsing/merging stays hand-written `node:fs`.
2. **Secret-free config.** Tokens resolve live from gh keyring / Keychain. New
   fields must be non-secret (permissions, pack names, model ids qualify; a raw
   API key does not, it would go through the live-resolution hook instead).
3. **Own only your block, never clobber the user.** Every write is either a
   marked block, a namespaced-key merge, or a whole file inscope created. A new
   JSON surface uses Pattern B; a new line-based surface uses Pattern A.
4. **Atomic writes only**, through `writeFileAtomic`. No partial files.
5. **Pure render pinned by a golden snapshot.** New generated output gets a
   `renderX` function and a snapshot in `test/golden.test.ts`.
6. **Idempotent and surgical.** Re-running apply changes nothing if nothing
   changed; removing a workspace prunes exactly what it added (`removeMcp`,
   `removePerWorkspaceGitconfig` are the precedents).
7. **macOS + zsh today.** doctor warns off-platform (`doctor.ts:80`). Capability
   files (skills/agents) are OS-agnostic and could be the first part of inscope
   that works on Linux; see the open decision in `05`.
