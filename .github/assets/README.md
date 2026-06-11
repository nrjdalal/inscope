# Demo assets

The README GIFs and the [vhs](https://github.com/charmbracelet/vhs) tapes that generate them.

| GIF | Tape | Shows |
| --- | --- | --- |
| `demo.gif` | `demo.tape` | `init`, interactive `add`, `list`, `doctor` |
| `demo-switch.gif` | `demo-switch.tape` | git email + token switching on `cd` |
| `demo-manage.gif` | `demo-manage.tape` | interactive `edit` and `rm` (type-to-confirm) |

`setup.sh` / `setup-seeded.sh` build a throwaway sandbox (`/tmp/inscope-demo`) with a stubbed `gh`, so recordings never touch your real config and never print a real token (only the safe names `nrjdalal` / `dalonic` appear).

## Regenerate

```sh
brew install vhs        # one-time (pulls ttyd)
bun run build           # tapes run dist/bin/index.mjs
# from the repo root:
vhs .github/assets/demo.tape
vhs .github/assets/demo-switch.tape
vhs .github/assets/demo-manage.tape
```

Or use the `record-demos` skill. Prompts use a leading-newline `PS1`/`PROMPT` to put a blank line between commands; bump `Set Height` in a tape if output is taller than the frame.
