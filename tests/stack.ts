// The running stack an end-to-end test drives, named by env so the same tests run against any local-stage deployment. Ported from zerostarter's tests/stack.ts, keeping only what this fork's suites use so far (the agent sign-in, seeding, and normalize helpers stay upstream until a test needs them). Nothing here imports app source: a suite tests the artifact that is serving, not the code that built it.
export const API = process.env.E2E_API_URL ?? ""
export const WEB = process.env.E2E_WEB_URL ?? ""

// The hosts a stack on this machine answers on; a .localhost name is the dev stack's portless proxy.
const LOCAL_HOSTS = new Set(["127.0.0.1", "[::1]", "host.docker.internal", "localhost"])

const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host) || host.endsWith(".localhost")

// A stack that is not on this machine is refused outright rather than skipped: a misconfigured job must fail, not run against a deployment.
for (const [name, url] of [
  ["E2E_API_URL", API],
  ["E2E_WEB_URL", WEB],
]) {
  if (url === "") continue
  const host = new URL(url).hostname
  if (!isLocalHost(host)) {
    throw new Error(`${name} points at ${host}; the suite runs only against a local stack`)
  }
}

// Every suite file guards itself with describe.skipIf(!enabled); bun run test:e2e is what names a stack.
export const enabled = API !== "" && WEB !== ""
