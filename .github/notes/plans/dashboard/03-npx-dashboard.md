# npx packaging

**Status:** parked.

Today the dashboard runs only inside this repo's dev stack (`bun run dev`, or
`bun tests/inscope/serve.ts` on a sandbox). Shipping it with the CLI as
`npx inscope dashboard` would serve the same pages and API from the published
package, bound to loopback, on the user's real `~/.config/inscope`.

Open questions:

- How to bundle the Next pages and the Hono routes into the CLI package without
  pulling the dev stack's runtime dependencies (database, auth) along.
- Which port it binds and how it is stopped.
