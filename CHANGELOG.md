# Changelog

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
