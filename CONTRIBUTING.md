# Contributing

inscope follows the tooling and workflow conventions of
[zerostarter](https://github.com/nrjdalal/zerostarter)
([zerostarter.dev](https://zerostarter.dev/blog/web-development-2026)), trimmed
to what a single-package CLI actually needs. The principle is the same one the
starter is built on: the gap between shippable and not is practices, not
syntax. Catch problems at commit time, keep boundaries clear.

## Toolchain

| Concern       | Tool                                               | Notes                                                          |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| Runtime / PM  | [Bun](https://bun.sh)                              | `bun install`, `bun test`. Lockfile is `bun.lock`.             |
| Bundler       | [tsdown](https://tsdown.dev)                       | Builds `dist/` from `src/index.ts` and `bin/index.ts`.         |
| Formatter     | [oxfmt](https://oxc.rs)                            | Replaces Prettier. Config in `.oxfmtrc.jsonc`.                 |
| Linter        | [oxlint](https://oxc.rs)                           | Replaces a separate ESLint setup. Config in `.oxlintrc.jsonc`. |
| Git hooks     | [lefthook](https://lefthook.dev)                   | Replaces simple-git-hooks. See `lefthook.yml`.                 |
| Commit format | commitlint + conventional config                   | Enforced in `commit-msg`.                                      |
| Changelog     | [changelogen](https://github.com/unjs/changelogen) | Generated from conventional commit titles.                     |

Why oxc (oxfmt + oxlint) over Prettier/ESLint: it is 50-100x faster, which
keeps the pre-commit hook instant. The `.oxfmtrc.jsonc` and `.oxlintrc.jsonc`
configs are inherited from zerostarter (`semi: false`, import sorting), so the
style is consistent across both repos.

### Common commands

```sh
bun run build            # bundle to dist/
bun run dev              # watch build
bun run test             # run the test + golden snapshot suite
bun test --update-snapshots  # regenerate goldens after a generator change (review the diff)
bun run typecheck        # tsc --noEmit (covers test/ too)
bun run lint             # oxlint
bun run format           # oxfmt (writes in place)
bun run format:check     # oxfmt --check (what CI gates on)
bun run changelog        # changelogen --bump (version + CHANGELOG.md)
```

Imports use `@/` for `src` and `~/` for the repo root.

## Architecture

inscope turns one source of truth, `~/.config/inscope/inscope.json`, into
per-workspace identity config and applies it idempotently. A **workspace** is a
mapped directory; from it inscope regenerates the zsh hook, the git `includeIf`
block, each workspace's `.mcp.json`, its isolated-login scaffolding, and its
Claude skill symlinks. The layering keeps side effects at the edges:

- `src/env.ts`, `src/secrets.ts`: read state, resolve paths and secrets. No file
  writes.
- `src/config.ts`: the config schema, hand-rolled validation, and `saveConfig`
  (the one place the config file is persisted, validated at the write boundary).
- `src/generators/*`: each pairs a pure render function (config in, text out,
  same input → same output) with the side-effecting `apply` / `remove` for that
  artifact.
  - `hook.ts`: the zsh `chpwd` hook that resolves the workspace from `$PWD`.
  - `mcp.ts`: each workspace's `.mcp.json` server block.
  - `gitconfig.ts`: the `~/.gitconfig` `includeIf` and per-workspace gitconfigs.
  - `isolate.ts`: the gitignored `<workspace>/.inscope` login scaffold and the
    `CLAUDE_CONFIG_DIR` export.
  - `settings.ts`: the isolated login's `.inscope/settings.json` (e.g. the
    `bypass` permission mode).
  - `skills.ts`: the shared skills cache and the symlinks into each workspace's
    personal Claude skills dir.
- `src/io.ts`: the single atomic writer (`writeFileAtomic`: temp + rename, and
  symlink-aware so a chezmoi/stow dotfile keeps its link) that every write goes
  through, plus the shared file readers.
- `src/managed-block.ts`: shared dotfiles (`~/.zshrc`, `~/.gitconfig`) are edited
  only inside a marked managed block, so re-applying never clobbers user edits.
  Whole files inscope owns (`.mcp.json` managed keys, per-workspace gitconfigs,
  `inscope.json`) are written directly through the atomic writer.
- `src/drift.ts`: compares on-disk artifacts against what the config would
  generate; powers `inscope diff` (and its `--adopt` back-sync).
- `src/doctor.ts`: verifies tokens, identities, the hook, each `.mcp.json`, and
  skill links resolve, each finding paired with its fix.
- `src/apply.ts`: orchestrates a full apply (pre-flights the `.mcp.json` parses
  so apply is all-or-nothing, then writes the hook, git includes, zshrc source
  line, each `.mcp.json`, the isolate scaffolds, and the skill links).
- `bin/`: the CLI surface (arg parsing, prompts, output) only. Logic belongs in
  `src/`, not here.

The render functions stay pure so the golden snapshot suite
(`test/golden.test.ts`) can pin their output. If you change a generator, the
snapshot diff is the review surface for the change: run
`bun test --update-snapshots`, then review the diff and decide whether the move
was intended. Never update snapshots blindly to silence a failing golden test.

## Pull requests

Synced from zerostarter's PR practices:

- **Conventional, scoped titles.** `feat(doctor): ...`, `fix(mcp): ...`,
  `docs: ...`, `ci: ...`, `chore: ...`. The PR title becomes a changelog line,
  so write it for the reader of the release notes. commitlint enforces this on
  every commit. No `Co-authored-by` trailer, and no em-dashes in prose.
- **Green before review.** `bun run lint`, `bun run format:check`,
  `bun run typecheck`, and `bun run test` all pass before opening a PR.
- **One concern per PR.** The auto-labeler tags PRs by the paths they touch
  (`core`, `cli`, `ci`, `docs`, `dependencies`, `test`, `build`); a PR that
  lights up every label is usually doing too much.
- **Keep the docs in sync.** A change to the CLI surface or behavior updates the
  README and the bundled self-skill (`skills/inscope/SKILL.md`) in the same PR.
- **Let the hooks help.** pre-commit formats + lints staged files and verifies
  the build; commit-msg runs commitlint; pre-push runs `bun audit`. Use
  `LEFTHOOK=0 git ...` only as a deliberate escape hatch.

## Dependencies

The daily `dependencies.yml` workflow runs `bun update` and opens a PR to keep
deps current. inscope has **zero runtime dependencies** by design; validation is
hand-rolled rather than pulling in a schema library. `bun audit --audit-level
high` runs on pre-push and must stay clean; patched transitive versions are
pinned in `package.json` `overrides` when a fix is not yet reachable through the
dependency ranges.

## Releasing

Bump the version in `package.json` and push to `main`:
`.github/workflows/release.yml` publishes to npm as `latest`, then
`auto-release.yml` generates the `CHANGELOG.md` section, tags `vX.Y.Z`, and
creates the GitHub release, so the changelog is never hand-written. The publish
is gated to `main`, so a version-bumped feature branch never publishes. A
maintainer comment starting with `/release` on a PR publishes a throwaway test
version for that PR's head.
