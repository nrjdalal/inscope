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

- ALWAYS: use `@/` for `src` imports and `~/` for repo-root imports.
- ALWAYS: write Conventional Commit messages, scoped (`feat(mcp):`, `fix(hook):`, `chore(tooling):`, `ci:`, `docs:`). The title becomes a changelog line.
- NEVER: include a `Co-authored-by` trailer in commit messages.
- NEVER: use em-dashes in prose.
- Keep logic in `src/`; `bin/` is the CLI surface (arg parsing, prompts, output) only.
- Generators are pure (config in, text out); all writes go through `src/apply.ts` and `src/managed-block.ts` and stay inside the marked managed block, so re-applying never clobbers user edits.

## Hooks

lefthook runs format + lint + build on pre-commit and commitlint on the message; `bun audit` runs on pre-push. Use `LEFTHOOK=0 git ...` only as a deliberate escape hatch.

## Releasing

Bump the `package.json` version manually and push to `main`. `release.yml` publishes to npm; `auto-release.yml` then generates the `CHANGELOG.md` section, tags `vX.Y.Z`, and creates the GitHub release. Do not hand-write the changelog.
