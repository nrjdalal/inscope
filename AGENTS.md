# AGENTS.md

This file provides guidance to AI coding agents working in the inscope repository. Architecture and toolchain rationale live in `CONTRIBUTING.md`.

## Instructions

- ALWAYS: after changing a generator (`src/generators/{hook,mcp,gitconfig}.ts`), regenerate the golden snapshots and review the diff:

  ```sh
  bun test --update-snapshots
  ```

  The snapshot diff is the review surface for the change. Never update snapshots blindly to silence a failing golden test; a failure means the generated output moved, so decide whether that was intended.

- ALWAYS: run the gates before committing.

  ```sh
  bun run format      # oxfmt (.oxfmtrc.jsonc: semi false, import sorting)
  bun run lint        # oxlint
  bun run typecheck   # tsc --noEmit (covers test/ too)
  bun run test        # unit + golden snapshots
  ```

- ALWAYS: before you commit or open/update a PR, run the `/ship` checklist (see Skills); it bundles the snapshot, gate, and docs/self-skill sync steps.
- ALWAYS: use `@/` for `src` imports and `~/` for repo-root imports.
- ALWAYS: write Conventional Commit messages, scoped (`feat(mcp):`, `fix(hook):`, `chore(tooling):`, `ci:`, `docs:`). The title becomes a changelog line.
- NEVER: include a `Co-authored-by` trailer in commit messages.
- NEVER: use em-dashes in prose.
- Keep logic in `src/`; `bin/` is the CLI surface (arg parsing, prompts, output) only.
- Generators pair pure render functions (config in, text out, snapshot-pinned) with the side-effecting apply/remove for that artifact. Every write goes through the atomic writer in `src/io.ts`; shared dotfiles (`~/.zshrc`, `~/.gitconfig`) are edited inside a marked managed block (`src/managed-block.ts`) so re-applying never clobbers user edits.

## Skills

This repo carries two skills in `.claude/skills/`, so they are always available in a Claude Code session here:

- `/ship`: the pre-PR checklist for a change to inscope. Run the gates, regenerate golden snapshots after a generator change, keep the README and the bundled self-skill in sync, and follow the commit conventions. Run it before you commit or open/update a PR.
- `/inscope`: the bundled self-skill (also shipped in the package at `skills/inscope/`), a guide to driving inscope. When you change the CLI or behavior, update it alongside the README.

## Hooks

lefthook runs format + lint + build on pre-commit and commitlint on the message; `bun audit` runs on pre-push. Use `LEFTHOOK=0 git ...` only as a deliberate escape hatch.

## Releasing

Bump the `package.json` version manually and push to `main`. `release.yml` publishes to npm; `auto-release.yml` then generates the `CHANGELOG.md` section, tags `vX.Y.Z`, and creates the GitHub release. Do not hand-write the changelog. Publishing authenticates via npm Trusted Publishing (OIDC, tied to this repo + `release.yml`); there is no `NPM_TOKEN` secret, so never add one back.
