# Demo assets

The README GIFs and the [vhs](https://github.com/charmbracelet/vhs) tapes that generate them, one per command.

| GIF          | Tape          | Shows                                                                                            |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------ |
| `init.gif`   | `init.tape`   | `init` creating the config, hook, and zshrc source line                                          |
| `add.gif`    | `add.tape`    | interactive `add`: gh picker, git identity, servers, Slack prompts, isolate                      |
| `edit.gif`   | `edit.tape`   | interactive `edit` pre-filled with current values; enables Slack + isolate                       |
| `rm.gif`     | `rm.tape`     | `rm` with a type-the-label confirm                                                               |
| `list.gif`   | `list.tape`   | `list` of the configured workspaces                                                              |
| `apply.gif`  | `apply.tape`  | `apply` regenerating the hook, includes, and each `.mcp.json`                                    |
| `diff.gif`   | `diff.tape`   | `diff` colored drift, then `--adopt` back-syncs an on-disk setting                               |
| `doctor.gif` | `doctor.tape` | `doctor` verifying tokens, identities, and the hook                                              |
| `status.gif` | `status.tape` | `status`: identity per directory, shared login in personal/work, isolated client in clients/acme |

`setup.sh` / `setup-seeded.sh` build a throwaway sandbox (`/tmp/inscope-demo`) with a stubbed `gh`, so recordings never touch your real config and never print a real token (only the safe names `nrjdalal` / `neeraj-acme-org` appear). `setup-seeded.sh` also pre-adds the `acme` and `personal` workspaces for the demos that show an existing setup. `setup-status.sh` seeds the `status` demo (a separate `/tmp/inscope-status-demo` sandbox) and additionally stubs `claude auth status --json`, so the recording shows the safe demo accounts `neeraj@personal.com` / `neeraj@work.com` / `neeraj@acme.com`, never a real login.

## Regenerate

```sh
brew install vhs        # one-time (pulls ttyd)
bun run build           # tapes run dist/bin/index.mjs
# from the repo root, render any (or all):
for t in init add edit rm list status apply diff doctor; do vhs ".github/assets/$t.tape"; done
```

Prompts use a leading-newline `PROMPT` to put a blank line between commands; bump `Set Height` in a tape if output is taller than the frame.
