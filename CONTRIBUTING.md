# Contributing

inscope is a [zerostarter](https://github.com/nrjdalal/zerostarter) fork
([zerostarter.dev](https://zerostarter.dev)): a Bun + Turborepo monorepo whose
product is the inscope CLI in `packages/cli` (the `inscope` npm package), tested
from `tests/packages/cli`. Both are fork-owned paths, so `bunx zerostarter sync`
brings upstream tooling and conventions in without touching them. `AGENTS.md`
holds the shared rules; this file covers what is specific to the CLI.

## Toolchain

| Concern       | Tool                                               | Notes                                                               |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| Runtime / PM  | [Bun](https://bun.sh)                              | `bun install`, `bun test`. Lockfile is `bun.lock`.                  |
| Monorepo      | [Turborepo](https://turbo.build)                   | Runs each package's `build` and `check-types`.                      |
| Bundler       | [tsdown](https://tsdown.dev)                       | Builds `packages/cli/dist/` from `src/index.ts` and `bin/index.ts`. |
| Formatter     | [oxfmt](https://oxc.rs)                            | Replaces Prettier. Config in `.oxfmtrc.jsonc`.                      |
| Linter        | [oxlint](https://oxc.rs)                           | Replaces a separate ESLint setup. Config in `.oxlintrc.jsonc`.      |
| Git hooks     | [lefthook](https://lefthook.dev)                   | Replaces simple-git-hooks. See `lefthook.yml`.                      |
| Commit format | commitlint + conventional config                   | Enforced in `commit-msg`.                                           |
| Changelog     | [changelogen](https://github.com/unjs/changelogen) | Generated from conventional commit titles.                          |

Why oxc (oxfmt + oxlint) over Prettier/ESLint: it is 50-100x faster, which
keeps the pre-commit hook instant. The `.oxfmtrc.jsonc` and `.oxlintrc.jsonc`
configs come from zerostarter (`semi: false`, import sorting), so the style is
consistent across both repos.

### Common commands

```sh
bun run build            # build every package (inscope lands in packages/cli/dist/)
bun run test             # build packages/*, then the suite in tests/
bun test tests/packages/cli --update-snapshots  # regenerate goldens after a generator change (review the diff)
bun run check-types      # tsc in every package, plus .github/scripts and each tests/ tsconfig
bun run lint             # oxlint
bun run format           # oxfmt (writes in place)
bun run format:check     # oxfmt --check (what CI gates on)
node packages/cli/dist/bin/index.mjs --help  # run the built CLI
```

Inside `packages/cli`, imports use `@/` for `src` and `~/` for the package root.

## Architecture

Paths below are under `packages/cli/`. inscope turns one source of truth, `~/.config/inscope/inscope.json`, into
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
(`tests/packages/cli/golden.test.ts`) can pin their output. If you change a
generator, the snapshot diff is the review surface for the change: run
`bun test tests/packages/cli --update-snapshots`, then review the diff and
decide whether the move was intended. Never update snapshots blindly to silence a failing golden test.

## Pull requests

Synced from zerostarter's PR practices:

- **Conventional, scoped titles,** following the `gh-commit` skill:
  `feat(doctor): ...`, `fix(mcp): ...`, `docs: ...`, `fix(ci): ...`,
  `build(deps): ...` (`ci` is reserved for pipeline commits). PRs are
  squash-merged, so the PR title becomes the changelog line: write it for the
  reader of the release notes. commitlint enforces the format on every commit.
  No `Co-authored-by` trailer, and no em-dashes in prose.
- **Branch from `canary`, PR into `canary`.** `main` only moves when canary is
  released (see Releasing).
- **Green before review.** `bun run lint`, `bun run format:check`,
  `bun run check-types`, and `bun run test` all pass before opening a PR. CI
  runs them on Ubuntu (`auto-check-build.yml`) and the suite again on macOS
  (`test-macos.yml`), where the zsh hook tests run.
- **One concern per PR.** The auto-labeler tags PRs by the paths they touch;
  a PR that lights up every label is usually doing too much.
- **Keep the docs in sync.** A change to the CLI surface or behavior updates the
  README and the bundled self-skill (`packages/cli/skills/inscope/SKILL.md`) in
  the same PR.
- **Let the hooks help.** pre-commit formats + lints staged files and verifies
  the build; commit-msg runs commitlint; pre-push runs `bun audit` on `canary`.
  Use `LEFTHOOK=0 git ...` only as a deliberate escape hatch.

## Dependencies

The inscope CLI has **zero runtime dependencies** by design; validation is
hand-rolled rather than pulling in a schema library. Its devDependencies come
from the root `catalog` (`"catalog:"`), which `bunx zerostarter sync` keeps on
upstream's versions; no bot opens update PRs, so the catalog moves with each
sync and the `bun update` that follows it (see below). `bun audit --audit-level high` runs on pre-push and in CI
and must stay clean, with one recorded exception: `braces`
(GHSA-vfj7-8cjw-p6xm) has no patched release and only dev tooling reaches it, so
both ignore it, as zerostarter's canary does.

## Syncing with zerostarter

`bunx zerostarter sync` (clean tree) overlays the latest zerostarter release and
leaves a diff to review. It never touches `packages/cli/`, `tests/`, or the
inscope docs and workflows. It keeps `AGENTS.md` because it is edited here, so
upstream's guide updates stop arriving: compare it with zerostarter's by hand
now and then. It does reset a few shared files to upstream, so re-apply these
before committing:

- `changelog.config.json`: the `revert` type (`"⏪ Reverts"`, semver patch), so a
  revert reaches the release notes.
- `.github/workflows/auto-check-build.yml` and `lefthook.yml`: the
  `--ignore GHSA-vfj7-8cjw-p6xm` braces audit ignore, until a zerostarter release
  carries it (its canary already does).
- The root `catalog`: run `bun update` (within the ranges) and check that
  `bun audit --audit-level high` is clean.

## Releasing

Releases follow zerostarter's flow. A push to `canary` that touches
`packages/cli`, `packages/scripts`, or `tests` publishes a canary build to npm
(`inscope@<next>-canary.<n>`), and every push to `canary` keeps a draft
`canary -> main` PR up to date. Merging that PR with a merge commit runs
`auto-release.yml`: it picks the version the window earned, writes the
`CHANGELOG.md` section, tags `vX.Y.Z`, and creates the GitHub release, so
neither the version nor the changelog is hand-written.
`.github/workflows/release.yml` then publishes that version to npm as `latest`
(`packages/cli/package.json` holds a `0.0.0` placeholder that the workflow
stamps). A maintainer comment starting with `/release` on a PR publishes a
throwaway test version for that PR's head. Keep `release.yml` under that name:
npm Trusted Publishing for `inscope` is bound to it.

### Repository settings

zerostarter does not ship its GitHub settings to forks, so these were applied
by hand, and the flow above depends on them:

- `canary` is the default branch, and merged PR branches are deleted.
- Actions keep read-only workflow permissions (each workflow asks for the scopes
  it needs), with "Allow GitHub Actions to create and approve pull requests" on
  so `auto-canary-into-main.yml` can open the release PR.
- The rulesets in `.github/rulesets/`. `main` takes changes only through a PR
  merged with a merge commit. `canary` blocks deletion and force pushes but has
  no PR rule: the release workflows push their `ci(version)` and
  `ci(changelog)` commits to it directly, and a personal repo cannot list
  GitHub Actions as a bypass actor. Admins bypass both. After editing one,
  apply it with
  `gh api -X PUT repos/nrjdalal/inscope/rulesets/<id> --input .github/rulesets/<name>.json`
  (`gh api repos/nrjdalal/inscope/rulesets` lists the ids).
