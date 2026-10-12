# CLI findings

**Status:** open. Each is a CLI fix in its own PR; the dashboard shows the
library's results as they are.

- doctor's `[ws] claude` check counts any file in an isolated `.inscope` as
  signed in, so a workspace can show "OK isolated login" beside an identity
  that reads "Not signed in".
- `skill update` skips skills pinned to a ref.
- Duplicate clones of a skill source turned up in the cache; the cause is not
  yet narrowed down.
- A link to a skill whose upstream deleted it is left dangling.
- With an empty keychain item, doctor suggests a command with `-s ''`.
- A non-string `url` on an HTTP server is not type-checked in the config.
