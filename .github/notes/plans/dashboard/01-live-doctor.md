# Live doctor

**Status:** parked.

`GET /api/inscope/doctor` runs every check (it spawns `gh`, `claude`, and git
per workspace) and answers once, so the page waits on the slowest. Streaming
each check as it finishes, over a WebSocket next to upstream's `/health/ws`,
would let the page fill in as they land.

Open questions:

- Whether `requireLocal` covers a WebSocket upgrade as it stands, or needs its
  own check on the upgrade request (Host, Origin, socket peer).
- Whether the page should keep a one-shot fallback for when the socket drops.
