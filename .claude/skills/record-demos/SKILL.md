---
name: record-demos
description: Regenerate the inscope demo GIFs in .github/assets from the vhs tapes. Use when CLI output or the demo flows change and the README GIFs need refreshing.
---

# Record demos

Regenerates `.github/assets/demo.gif`, `demo-switch.gif`, and `demo-manage.gif` from the committed [vhs](https://github.com/charmbracelet/vhs) tapes. The tapes record against a throwaway `$HOME` (`/tmp/inscope-demo`) with a stubbed `gh`, so they never touch real config or print real tokens — only the safe account names `nrjdalal` / `dalonic` appear.

## Prerequisites

- `vhs` (also installs `ttyd`): `brew install vhs`
- A current build: `bun run build` (the tapes run `dist/bin/index.mjs`)

## Steps

1. `bun run build`
2. From the repo root, render each tape:
   - `vhs .github/assets/demo.tape`
   - `vhs .github/assets/demo-switch.tape`
   - `vhs .github/assets/demo-manage.tape`
   - If vhs fails with `could not open ttyd: ... ERR_CONNECTION_REFUSED`, the command sandbox is blocking the local ttyd server — run vhs outside the sandbox.
3. Sanity-check a frame visually:
   `ffmpeg -y -sseof -1.5 -i .github/assets/demo-manage.gif -frames:v 1 /tmp/check.png` then open `/tmp/check.png`.
4. Commit the updated GIFs.

## Tweaking

- Sandbox / fake `gh` / prompt: `.github/assets/setup.sh` (hero) and `setup-seeded.sh` (switch + manage).
- Flow, keystrokes, timing, dimensions: the `.tape` files.
- Prompts use a leading-newline `PS1`/`PROMPT` so there is a blank line between commands. If output is taller than the frame, raise `Set Height` in the tape.
