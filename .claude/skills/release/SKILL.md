---
name: release
description: Cut a new inscope npm release. Bumps the version, commits, and pushes; GitHub Actions publishes to npm as latest. Use when shipping a new version of the inscope CLI.
---

# Release

inscope auto-publishes on push: `.github/workflows/release.yml` runs on every push to any branch. If `package.json` `version` differs from the npm `latest` dist-tag, it publishes that version as `latest`; if they match, it publishes a `canary` (harmless, does not move `latest`).

## Steps

1. Clean tree, checks green:
   `bun run typecheck && bun test && bun run build`
2. Pick the next version (semver — this is `0.x`, so breaking changes bump the minor). Confirm it is not already published:
   `npm view inscope@<version> version` (must error / be empty — npm refuses to republish an existing version).
3. Bump `version` in `package.json`.
4. Commit with a conventional message (commitlint is enforced): `chore(release): <version>`.
5. Push: `git push origin main`.
6. Watch the run:
   `gh run watch $(gh run list -R nrjdalal/inscope --workflow="Release Package" -L 1 --json databaseId --jq '.[0].databaseId') -R nrjdalal/inscope --exit-status`
7. Verify `latest`: `npm view inscope dist-tags`.

## Gotchas

- Stage with `git add -A` (then unstage `package.json` for a separate release commit) — do not hand-enumerate files. A missed file once shipped a broken release (`0.2.0`).
- `NPM_TOKEN` must exist in the repo secrets (it does).
- The README ships in the npm tarball; its GIFs are referenced by absolute `raw.githubusercontent.com/.../main/.github/assets/...` URLs so they render on npm too. If you move or rename those assets, re-release so the published README does not point at dead URLs.
- The publish strips dev-only `package.json` fields and ships only `dist` (plus the README/LICENSE npm always includes).
