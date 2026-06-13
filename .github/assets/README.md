# Demo assets

The README GIFs and the [vhs](https://github.com/charmbracelet/vhs) tapes that generate them: one hero plus one per command.

| GIF          | Tape          | Shows                                                              |
| ------------ | ------------- | ------------------------------------------------------------------ |
| `demo.gif`   | `demo.tape`   | hero: git email + `GITHUB_TOKEN` flip on `cd`, cleared outside     |
| `init.gif`   | `init.tape`   | `init` creating the config, hook, and zshrc source line            |
| `add.gif`    | `add.tape`    | interactive `add`: gh picker, git identity, servers, Slack prompts |
| `edit.gif`   | `edit.tape`   | interactive `edit` pre-filled with the workspace's current values  |
| `rm.gif`     | `rm.tape`     | `rm` with a type-the-label confirm                                 |
| `list.gif`   | `list.tape`   | `list` of the configured workspaces                                |
| `apply.gif`  | `apply.tape`  | `apply` regenerating the hook, includes, and each `.mcp.json`      |
| `diff.gif`   | `diff.tape`   | `diff` colored drift, then `--adopt` back-syncs an on-disk setting |
| `doctor.gif` | `doctor.tape` | `doctor` verifying tokens, identities, and the hook                |

`setup.sh` / `setup-seeded.sh` build a throwaway sandbox (`/tmp/inscope-demo`) with a stubbed `gh`, so recordings never touch your real config and never print a real token (only the safe names `nrjdalal` / `neeraj-acme-org` appear). `setup-seeded.sh` also pre-adds the `acme` and `personal` workspaces for the demos that show an existing setup.

## Regenerate

```sh
brew install vhs        # one-time (pulls ttyd)
bun run build           # tapes run dist/bin/index.mjs
# from the repo root, render any (or all):
for t in demo init add edit rm list apply diff doctor; do vhs ".github/assets/$t.tape"; done
```

Prompts use a leading-newline `PROMPT` to put a blank line between commands; bump `Set Height` in a tape if output is taller than the frame.
