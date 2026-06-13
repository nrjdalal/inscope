# Demo assets

The README GIFs and the [vhs](https://github.com/charmbracelet/vhs) tapes that generate them.

| GIF               | Tape               | Shows                                                                            |
| ----------------- | ------------------ | -------------------------------------------------------------------------------- |
| `demo.gif`        | `demo.tape`        | `init`, interactive `add` (gh picker + server multiselect), `list`, `doctor`     |
| `demo-switch.gif` | `demo-switch.tape` | git email + token switching on `cd`, cleared outside any workspace               |
| `demo-manage.gif` | `demo-manage.tape` | interactive `edit` and `rm` (type-the-label confirm)                             |
| `demo-diff.gif`   | `demo-diff.tape`   | `diff` previews drift as a colored diff; `--adopt` back-syncs an on-disk setting |
| `demo-slack.gif`  | `demo-slack.tape`  | adding Slack: keychain prompt and the Yes/No selectors                           |

`setup.sh` / `setup-seeded.sh` build a throwaway sandbox (`/tmp/inscope-demo`) with a stubbed `gh`, so recordings never touch your real config and never print a real token (only the safe names `nrjdalal` / `neeraj-acme-org` appear).

## Regenerate

```sh
brew install vhs        # one-time (pulls ttyd)
bun run build           # tapes run dist/bin/index.mjs
# from the repo root:
vhs .github/assets/demo.tape
vhs .github/assets/demo-switch.tape
vhs .github/assets/demo-manage.tape
vhs .github/assets/demo-diff.tape
vhs .github/assets/demo-slack.tape
```

Prompts use a leading-newline `PROMPT` to put a blank line between commands; bump `Set Height` in a tape if output is taller than the frame.
