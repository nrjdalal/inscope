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
bun run build        # bundle to dist/
bun run dev          # watch build
bun run test         # run the test + golden snapshot suite
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint
bun run format       # oxfmt (writes in place)
bun run format:check # oxfmt --check (what CI gates on)
bun run changelog    # changelogen --bump (version + CHANGELOG.md)
```

## Architecture

inscope generates per-workspace identity config from one source of truth and
applies it idempotently. The layering:

- `src/env.ts`, `src/secrets.ts`: read state, resolve paths / secrets. No file
  writes.
- `src/config.ts`: the config schema, validation, and `saveConfig` (the one
  place the config file is persisted, validated at the write boundary).
- `src/generators/*` (`hook.ts`, `mcp.ts`, `gitconfig.ts`): each pairs pure
  render functions (config in, text out, same input → same output) with the
  side-effecting `apply` / `remove` for that artifact.
- `src/io.ts`: the single atomic writer (`writeFileAtomic`: temp + rename, and
  symlink-aware so a chezmoi/stow dotfile keeps its link) that every write goes
  through, plus the shared file readers.
- `src/managed-block.ts`: shared dotfiles (`~/.zshrc`, `~/.gitconfig`) are edited
  only inside a marked managed block, so re-applying never clobbers user edits.
  Whole files inscope owns (`.mcp.json` managed keys, per-workspace gitconfigs,
  `inscope.json`) are written directly through the atomic writer.
- `src/apply.ts`: orchestrates a full apply (pre-flights the `.mcp.json` parses
  so apply is all-or-nothing, then writes the hook, git includes, zshrc source
  line, and each `.mcp.json`).
- `bin/`: the CLI surface (commands, prompts). Logic belongs in `src/`, not
  here.

The render functions stay pure so the golden snapshot suite
(`test/golden.test.ts`) can pin their output. If you change generated output,
the snapshot diff is the review surface; update it deliberately, never blindly.

## Pull requests

Synced from zerostarter's PR practices:

- **Conventional, scoped titles.** `feat(doctor): ...`, `fix(mcp): ...`,
  `docs: ...`, `ci: ...`, `chore: ...`. The PR title becomes a changelog line,
  so write it for the reader of the release notes. commitlint enforces this on
  every commit.
- **Green before review.** `bun run lint`, `bun run format:check`,
  `bun run typecheck`, and `bun run test` all pass before opening a PR.
- **One concern per PR.** The auto-labeler tags PRs by the paths they touch
  (`core`, `cli`, `ci`, `docs`, `dependencies`, `test`, `build`); a PR that
  lights up every label is usually doing too much.
- **Let the hooks help.** pre-commit formats + lints staged files and verifies
  the build; commit-msg runs commitlint; pre-push runs `bun audit`. Use
  `LEFTHOOK=0 git ...` only as a deliberate escape hatch.

## Dependencies

The daily `dependencies.yml` workflow runs `bun update` and opens a PR to keep
deps current. `bun audit --audit-level high` runs on pre-push and must stay
clean; patched transitive versions are pinned in `package.json` `overrides`
when a fix is not yet reachable through the dependency ranges.

## Releasing

Bump the version in `package.json` (and refresh `CHANGELOG.md` with
`bun run changelog`); pushing to `main` triggers `.github/workflows/release.yml`,
which publishes to npm as `latest`. The publish is gated to `main`, so a
version-bumped feature branch never publishes. A maintainer comment starting
with `/release` on a PR publishes a throwaway test version for that PR's head.
