# Dashboard follow-ups

The read-only dashboard (`/inscope` in the dev stack, PR #73) ships local and
read-only by construction; see CONTRIBUTING.md, Dashboard. These are the next
steps it deliberately left out, plus what building it turned up in the CLI.
Each is its own PR.

| Item                                   | Status | What                                                                 |
| -------------------------------------- | ------ | -------------------------------------------------------------------- |
| [Live doctor](./01-live-doctor.md)     | parked | Stream doctor's checks over a WebSocket instead of one request       |
| [Mutations](./02-mutations.md)         | parked | Let the dashboard run `apply` and friends, behind a per-launch token |
| [npx packaging](./03-npx-dashboard.md) | parked | Ship the dashboard with the CLI as `npx inscope dashboard`           |
| [CLI findings](./04-cli-findings.md)   | open   | Library bugs the dashboard surfaced, fixed in the CLI, not here      |
