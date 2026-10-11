---
name: ship
description: Prepare a change to the inscope CLI for a PR. Use before committing or opening a PR, to refresh snapshots, sync the README and self-skill, pass the gates, and commit.
source: local
---

# Ship a change to inscope

Getting a change out as a PR into `canary`; `release.yml` publishes it (a canary once it reaches `canary`, `latest` when canary is released to main). Work the steps in order; each is done when its check passes.

## Steps

1. **Refresh snapshots if a snapshot-pinned generator changed.** After editing `packages/cli/src/generators/{gitconfig,hook,mcp}.ts`, run `bun test tests/packages/cli --update-snapshots` and review the diff. Done when the diff is intended or empty; treat a moved snapshot as a change to decide on, not noise to silence.
2. **Sync docs to the change.** If a command, flag, field, or behavior changed, update `README.md` (command table, section, config example) and the bundled self-skill `packages/cli/skills/inscope/SKILL.md`. Keep the self-skill's frontmatter valid YAML by quoting or rephrasing any value that contains a colon. Done when both match the new behavior.
3. **Pass the gates.** `bun run format && bun run lint && bun run check-types && bun run test`. Done when all four pass and the diff adds no em-dashes.
4. **Commit.** One Conventional Commit, scoped (`feat(skills):`, `fix(hook):`, `docs:`, `chore(tooling):`, `ci:`), the title as a changelog line, no `Co-authored-by` trailer. Done when the working tree is clean.
5. **Open or update the PR.** Branch from `origin/canary` and open the PR against `canary`. Merge only on an explicit go-ahead. Done when the PR reflects the change and CI is green.

## Reference

- Repo-only: this skill is not shipped in the package.
- Inside `packages/cli`, imports use `@/` for `src` and `~/` for the package root.
- Zero runtime dependencies; hand-roll validation rather than add a library.
