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
sync and the `bun update` that follows it (see Syncing with zerostarter).

`bun audit --audit-level high` runs on pre-push and in CI and must stay clean,
with one recorded exception: `braces` (GHSA-vfj7-8cjw-p6xm) has no patched
release and only dev tooling reaches it, so both ignore it, as zerostarter's
canary does.

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
- The dashboard's hooks into upstream files:
  - `api/hono/src/lib/error.ts`: the `INSCOPE_CONFIG_INVALID` and
    `INSCOPE_WORKSPACE_NOT_FOUND` codes, `inscopeConfigErrorResponses` and
    `inscopeWorkspaceErrorResponses`, and the `requireLocal` mention in the
    `forbiddenErrorResponses` comment;
  - the `.route("/inscope", inscopeRouter)` line in `api/hono/src/index.ts` and
    its re-export in `api/hono/src/routers/index.ts`;
  - the `/api` rewrite's `source` in `web/next/next.config.ts`, which skips
    `/api/inscope` (dropping it reopens the dashboard API to the LAN through
    `next dev`);
  - the `isDashboardPath` case that hides the marketing navbar on the
    dashboard's pages in `web/next/src/components/common/navbar.tsx`.

## Dashboard

A read-only web view of this machine's inscope state is the dev stack's home
page: `web/next/src/app/(inscope)` renders it at `/` (its sections at `/skills`,
`/doctor`, `/diff`, and `/workspaces/<name>`, listed in `inscopePaths` in
`web/next/src/lib/inscope.ts`), and
`api/hono/src/routers/inscope.ts` serves it at `/api/inscope` from the inscope
library (`packages/cli/src`, imported as the `inscope` workspace package). It
shows each workspace's identity, MCP servers, skills, the doctor checks, and
what `apply` would change.

- It is local by construction. The pages render only under `next dev`, and a
  production build answers 404 at every one of them, the home page included,
  since the fork's starter placeholder home is gone. The API
  routes (`requireLocal`, `api/hono/src/middlewares/local.ts`) answer only on
  the `local` stage, and only to a request addressed to a loopback name from a
  loopback socket peer. A request relayed by a proxy on this machine must name
  its client, and every host and client it names must be loopback (portless
  appends the real client to `x-forwarded-for`); these headers can refuse a
  request but never admit one. `next dev`'s `/api` rewrite
  (`web/next/next.config.ts`) relays from loopback and passes the caller's own
  Host and forwarding headers along, so anyone who can reach port 3000 could
  forge them: the rewrite skips `/api/inscope`, and since its matcher does not
  decode, the gate refuses any percent-encoded path (the pages call the API
  directly). A cross-site browser request is refused, a write needs a trusted
  Origin, and every response the routes give, refusals included, is
  `Cache-Control: no-store` (a CORS preflight is answered before them, by the
  app's CORS middleware, with no body).
- It shows booleans for tokens and keychain items, never values. Everything
  else that can carry a credential is redacted by `api/hono/src/lib/redact.ts`.
  A `.mcp.json` is redacted by structure before it is diffed:
  - every `env` and `headers` value that does more than name a variable (with at
    most an auth scheme before it, Claude Code's own `Bearer ${API_KEY}`) or set
    an on/off toggle (`true`, `off`, `yes`);
  - anything under a key that names a credential, judged word by word (`apiKey`,
    `DB_PASSWORD`, `X-Api-Key`, `jwt`, and `clientCreds` count; `keycloak`,
    `oauth`, and `clientId` do not), while server names are never judged;
  - the value after a credential flag, a docker `-e`/`--env`, or `--env=K=V`;
  - in any string, JSON inside a string included: the user info, query,
    fragment, and long opaque path segments (24+ characters mixing letters and
    digits, the token some hosted servers carry in the URL) of a URL in any
    scheme, and user info with no scheme (`oauth2:<token>@gitlab.com/...`); an
    HTTP auth scheme's token in any case (`Bearer ...`, `basic ...`); a token
    whose vendor prefix gives it away (`AKIA`, `ghp_`, `github_pat_`, `glpat-`,
    `lin_api_`, `npm_`, `ntn_`, `sk-`, `xoxb-`, and others), even as a bare
    argument; the value after a credential flag (`--api-key <key>`, in one
    string as across two arguments); and a `name=value`, a quoted
    `"name": "value"`, or a `Name: value` header (to the end of its line) whose
    name says credential, its value bare, quoted, or in escaped quotes inside
    one string (`API_KEY="..."`, `X-Api-Key: '...'`, `--api-key \"...\"`).

    A harmless name's or flag's quoted value is searched in turn
    (`helper = "!f() { echo password=...; }; f"`, `sh -c "npx ... --api-key ..."`),
    and a credential-named variable's shell default is withheld
    (`${API_KEY:-<redacted>}`). A printf line escape (`\n`, or `\\n` inside a git
    config string) ends a bare value and starts a new name, so a credential
    helper's `printf 'username=me\npassword=...\n'` withholds the password.
    A value filled in at run time (`${...}`, `$(...)`, a value that is only
    `%s` or a lone `$var` after at most an auth scheme, the `$var` outside
    single quotes, which keep `$` literal, or what a shell splice leaves in a
    quoted pair, as in Claude Code's documented
    `echo '{"Authorization": "Bearer '"$(get-token)"'"}'`) is kept, so inscope's
    own `headersHelper` and hook stay readable, and so is a name that only holds
    a credential word (`maxTokens`, `tokenizer`) or ends in `file`, `path`,
    `dir`, or `url` (`KEY_FILE`, `cookieFile`).

  The `diff --adopt` lines go through the same string rules, and so do a git
  skill's source, the message for an invalid config, and the pending changes to
  the hook and git includes, which a hand edit can put a credential in
  (`[url "https://user:token@host/"]`). A git skill's cache folder is named
  after its URL, so a path into one (in a skill link, a doctor detail, or a
  pending change) is shown only when the folder belongs to a declared skill
  whose URL carries no credential.

- `bun run dev` opens it on your real `~/.config/inscope`, through portless at
  `http://inscope.localhost:1355`. To work on it without your own logins, run it
  on a sealed sandbox instead:

```bash
bun tests/inscope/serve.ts           # seed a sandbox, start the stack, run the e2e suites
bun tests/inscope/serve.ts --keep    # the same, left up through portless instead
```

`--keep` serves the sandbox at `http://sandbox.inscope.localhost:1355` (API at
`sandbox.api.inscope.localhost`), names of its own so it never takes the real
stack's; the e2e run stays on ports 3000 and 4000, which CI has without a
portless proxy. Either one needs the real stack's `next dev` stopped first,
since Next allows one dev server per app.

The sandbox (`tests/inscope/sandbox.ts`) is its own HOME with stub `gh`,
`claude`, and `security` on PATH, three workspaces applied by the real CLI, and
deliberate drift, credentials included. The router, gate, and redaction tests
(`tests/api/hono/src/{routers,middlewares,lib}/`) run in `bun run test`. The
e2e suites mirror their subjects (`tests/api/hono/src/routers/inscope.e2e.test.ts`,
`tests/web/next/src/app/(inscope)/layout.e2e.test.ts`), read the stack
from `tests/stack.ts`, and also need `E2E_INSCOPE_SANDBOX`, which only
`tests/inscope/serve.ts` sets, since their expectations are the sandbox's. The
browser half runs where `agent-browser` is installed, as it is in CI
(`test-e2e.yml`); `E2E_SCREENSHOT_DIR` keeps its screenshots.

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
stamps). Keep `release.yml` under that name: npm Trusted Publishing for
`inscope` is bound to it.

`gh workflow run release.yml -f pr=<n>` publishes a same-repo PR's head as a
throwaway test version (`0.0.0-<sha>` on the npm `test` dist-tag) and links it
on the PR. It stands in for zerostarter's `/release` comment: tried on #69, that
comment's publish got `E404` on PUT from npm (run 38151080146) while
push-triggered publishes go through, so npm appears to refuse Trusted
Publishing from `issue_comment` runs.

### Repository settings

zerostarter does not ship its GitHub settings to forks, so these were applied
by hand, and the flow above depends on them:

- `canary` is the default branch, and merged PR branches are deleted.
- All three merge methods stay allowed, as upstream: the release PR needs merge
  commits, canary PRs squash by convention (no rule enforces it), and rebase
  merges go unused.
- Actions keep read-only workflow permissions (every workflow that writes
  declares its own scopes), with "Allow GitHub Actions to create and approve
  pull requests" on so `auto-canary-into-main.yml` can open the release PR.
- The rulesets live in `.github/rulesets/`, and admins bypass both:
  - `main.json` is upstream's file unchanged.
  - `canary.json` drops upstream's PR rule and keeps only deletion and
    force-push protection, because the release workflows push their
    `ci(version)` and `ci(changelog)` commits to canary directly and a personal
    repo cannot list GitHub Actions as a bypass actor (zerostarter's live canary
    ruleset is the same).

After editing a ruleset file, apply it (the first command lists the ids):

```bash
gh api 'repos/{owner}/{repo}/rulesets' -q '.[] | "\(.id) \(.name)"'
gh api -X PUT 'repos/{owner}/{repo}/rulesets/<id>' --input .github/rulesets/<name>.json
```
