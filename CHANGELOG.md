# Changelog

## v0.11.0

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.10.0...v0.11.0)

### 🚀 Enhancements

- **status:** Add `inscope status` for the identity resolved per directory ([#30](https://github.com/nrjdalal/inscope/pull/30))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.10.0

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.9.0...v0.10.0)

### 🚀 Enhancements

- Deliver per-workspace identity to any launcher ([65c7320](https://github.com/nrjdalal/inscope/commit/65c7320))
- **skills:** Per-workspace Claude skill manager ([a62f25f](https://github.com/nrjdalal/inscope/commit/a62f25f))
- **skills:** Add `skill rename` to rename a skill and its /command ([906744e](https://github.com/nrjdalal/inscope/commit/906744e))

### 🩹 Fixes

- Flag stale bypass and tidy bypass file handling ([516f9ff](https://github.com/nrjdalal/inscope/commit/516f9ff))
- **skills:** Route non-isolated skills to the base login dir ([06bc976](https://github.com/nrjdalal/inscope/commit/06bc976))

### 📖 Documentation

- Note the first-run project-MCP trust gate ([1f09ddd](https://github.com/nrjdalal/inscope/commit/1f09ddd))
- **skills:** Record the global-CCD-in-isolated-cwd base fallback ([2025197](https://github.com/nrjdalal/inscope/commit/2025197))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.9.0

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.9...v0.9.0)

### 🚀 Enhancements

- Default the Slack MCP package to @nrjdalal/slack-mcp-server ([a8171d1](https://github.com/nrjdalal/inscope/commit/a8171d1))
- **claude:** Opt-in per-workspace Claude login via an isolated .inscope dir ([a190d71](https://github.com/nrjdalal/inscope/commit/a190d71))

### 🩹 Fixes

- **claude:** Flag the leftover .inscope login on rm and un-isolate ([297c954](https://github.com/nrjdalal/inscope/commit/297c954))

### 📖 Documentation

- **readme:** Document isolated workspaces and the claude launch flags ([e08c881](https://github.com/nrjdalal/inscope/commit/e08c881))
- **readme:** Rewrite for clarity and lead with isolated Claude logins ([fa7e516](https://github.com/nrjdalal/inscope/commit/fa7e516))
- **assets:** Regenerate demo GIFs for the isolate prompt and Slack fork default ([8c3d1e8](https://github.com/nrjdalal/inscope/commit/8c3d1e8))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.9

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.8...v0.8.9)

### 🩹 Fixes

- **diff:** Round-trip the fork's write toggle through adopt; tighten package parsing ([c07a440](https://github.com/nrjdalal/inscope/commit/c07a440))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.8

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.7...v0.8.8)

### 🚀 Enhancements

- **diff:** Adopt the Slack package from .mcp.json ([3bb4622](https://github.com/nrjdalal/inscope/commit/3bb4622))

### 🩹 Fixes

- **mcp:** Render the @nrjdalal Slack fork per its own CLI ([b6d66bd](https://github.com/nrjdalal/inscope/commit/b6d66bd))

### 📖 Documentation

- **demo:** Re-record add/edit tapes for the Slack package picker ([110fc69](https://github.com/nrjdalal/inscope/commit/110fc69))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.7

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.6...v0.8.7)

### 🚀 Enhancements

- **mcp:** Let Slack setup pick the server package ([0bf3feb](https://github.com/nrjdalal/inscope/commit/0bf3feb))
- **add:** Treat --slack-package as a Slack-enabling flag ([994f3ce](https://github.com/nrjdalal/inscope/commit/994f3ce))

### 🩹 Fixes

- **env:** Honor $HOME so apply and tests don't pollute the real ~/.zshrc ([9fc48a8](https://github.com/nrjdalal/inscope/commit/9fc48a8))

### 📖 Documentation

- **readme:** Add a zero-dep highlight, features list, and more-tools footer ([fb2d0f0](https://github.com/nrjdalal/inscope/commit/fb2d0f0))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.6

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.5...v0.8.6)

### 📖 Documentation

- **readme:** Make the global install optional, lead with npx ([aac5fc6](https://github.com/nrjdalal/inscope/commit/aac5fc6))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.5

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.4...v0.8.5)

### 📖 Documentation

- Rewrite the README around per-command demos ([6fb479d](https://github.com/nrjdalal/inscope/commit/6fb479d))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.4

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.3...v0.8.4)

### 🩹 Fixes

- **apply:** Atomic transactional writes sharing one mcp merge ([f245507](https://github.com/nrjdalal/inscope/commit/f245507))
- **cli:** Doctor shell check, diff --exit-code, safe prompt teardown ([9b03324](https://github.com/nrjdalal/inscope/commit/9b03324))
- **io:** Preserve the target file mode in writeFileAtomic ([50f7cf4](https://github.com/nrjdalal/inscope/commit/50f7cf4))

### 📖 Documentation

- **audit:** Add 2026-06-13 audit, drop the stale multi-tool sketch ([464c948](https://github.com/nrjdalal/inscope/commit/464c948))
- Reconcile the architecture and release-trigger notes ([b229ee9](https://github.com/nrjdalal/inscope/commit/b229ee9))
- Restore the demo tapes and gifs in-repo ([be117b9](https://github.com/nrjdalal/inscope/commit/be117b9))

### ✅ Tests

- Zsh -n hook validation and apply-path coverage ([04ae750](https://github.com/nrjdalal/inscope/commit/04ae750))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.3

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.2...v0.8.3)

### 🚀 Enhancements

- **add:** Clearer git prompts, relocate cleanup, tested duplicate-path guard ([d56b61d](https://github.com/nrjdalal/inscope/commit/d56b61d))

### 📖 Documentation

- **readme:** Unstack the demo gifs, add an inscope diff section ([5dd4109](https://github.com/nrjdalal/inscope/commit/5dd4109))

### 🎨 Styles

- **diff:** Lead the result messages with a blank line ([03ce5d7](https://github.com/nrjdalal/inscope/commit/03ce5d7))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.2

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.1...v0.8.2)

### 🚀 Enhancements

- **add:** Refuse duplicate-path mappings, warn on unknown servers ([b68e0b7](https://github.com/nrjdalal/inscope/commit/b68e0b7))

### 🩹 Fixes

- **config:** Reject backslash in hook values (quote-breakout) ([20b121e](https://github.com/nrjdalal/inscope/commit/20b121e))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.1

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.8.0...v0.8.1)

### 🚀 Enhancements

- **add:** Warn when the workspace path does not exist yet ([debb37a](https://github.com/nrjdalal/inscope/commit/debb37a))
- **config:** Reject a config written by a newer inscope ([e2d1dd8](https://github.com/nrjdalal/inscope/commit/e2d1dd8))

### 🩹 Fixes

- Resolve nested workspaces correctly and block gitconfig injection ([8b7c914](https://github.com/nrjdalal/inscope/commit/8b7c914))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.8.0

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.7.0...v0.8.0)

### 🚀 Enhancements

- Add `inscope diff` with back-sync, and detect mcp drift in doctor ([3bfa9b8](https://github.com/nrjdalal/inscope/commit/3bfa9b8))

### 📖 Documentation

- Add AGENTS.md agent rules, symlink CLAUDE.md to it ([27284e1](https://github.com/nrjdalal/inscope/commit/27284e1))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.7.0

[compare changes](https://github.com/nrjdalal/inscope/compare/v0.6.0...v0.7.0)

### 🩹 Fixes

- Harden workspace name/path/gh/keychain so the generated zsh hook is always safe ([145b99f](https://github.com/nrjdalal/inscope/commit/145b99f))

### 📖 Documentation

- Clarify gh requirement and add multi-tool MCP design note ([861550c](https://github.com/nrjdalal/inscope/commit/861550c))

### 🏡 Chore

- **tooling:** Sync zerostarter toolchain (oxc, lefthook, changelogen) ([d23faf9](https://github.com/nrjdalal/inscope/commit/d23faf9))

### ✅ Tests

- Add a golden snapshot suite and gate releases on tests ([0f9dfc3](https://github.com/nrjdalal/inscope/commit/0f9dfc3))
- Lock golden coverage for every generator edge case ([ed88ce7](https://github.com/nrjdalal/inscope/commit/ed88ce7))

### 🎨 Styles

- Format and lint the codebase with oxfmt and oxlint ([4ba37b5](https://github.com/nrjdalal/inscope/commit/4ba37b5))

### ❤️ Contributors

- Neeraj Dalal @nrjdalal

## v0.6.0

### 🚀 Enhancements

- Selectable confirms, clickable Slack link, consistent output spacing ([e867eda](https://github.com/nrjdalal/inscope/commit/e867eda))

## v0.5.3

### 📖 Documentation

- Serve demo gifs from the demo-kit repo ([04ef81b](https://github.com/nrjdalal/inscope/commit/04ef81b))

## v0.5.2

### 📖 Documentation

- Surface the design blog link at the top of the README ([42609de](https://github.com/nrjdalal/inscope/commit/42609de))

## v0.5.1

### 🩹 Fixes

- Align inscope add help options to a 2-space indent ([71b8cc7](https://github.com/nrjdalal/inscope/commit/71b8cc7))

## v0.5.0

### 🚀 Enhancements

- Add 7 more OAuth MCP servers and an interactive-first README ([bda79ab](https://github.com/nrjdalal/inscope/commit/bda79ab))

## v0.4.0

### 🚀 Enhancements

- Add Atlassian, Plane, Sentry and Vercel MCP servers ([1dd72bc](https://github.com/nrjdalal/inscope/commit/1dd72bc))

## v0.3.2

### 🏡 Chore

- Relocate demo assets to .github/assets, add generator scripts + skills ([fdda5f8](https://github.com/nrjdalal/inscope/commit/fdda5f8))

## v0.3.1

### 📖 Documentation

- Add interactive demo gif to the README ([aa92d71](https://github.com/nrjdalal/inscope/commit/aa92d71))
- Add cd-switch and manage demo gifs ([b5b1c35](https://github.com/nrjdalal/inscope/commit/b5b1c35))

## v0.3.0

### 🚀 Enhancements

- Interactive edit and rm with shared workspace prompts ([c0da345](https://github.com/nrjdalal/inscope/commit/c0da345))

## v0.2.1

### 🩹 Fixes

- Env paths missed the ~/.config/inscope move in 0.2.0 ([d940568](https://github.com/nrjdalal/inscope/commit/d940568))

## v0.2.0

### 🚀 Enhancements

- ⚠️ Scope identity under ~/.config/inscope with interactive add ([3862e58](https://github.com/nrjdalal/inscope/commit/3862e58))

### 📖 Documentation

- Rewrite README in gitpick style ([ddd65ca](https://github.com/nrjdalal/inscope/commit/ddd65ca))

#### ⚠️ Breaking Changes

- ⚠️ Scope identity under ~/.config/inscope with interactive add ([3862e58](https://github.com/nrjdalal/inscope/commit/3862e58))

## v0.1.1

### 🚀 Enhancements

- Initial release ([4922427](https://github.com/nrjdalal/inscope/commit/4922427))
