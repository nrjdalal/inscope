// Runs the dashboard end to end against a sealed sandbox: seeds one (tests/inscope/sandbox.ts), starts the API on it at :4000 and `next dev` at :3000, then runs the dashboard's e2e suites, or with --keep leaves both up for a browser. `bun tests/inscope/serve.ts [--dir <path>] [--keep]`; E2E_SCREENSHOT_DIR makes the browser suite save its screenshots there.
import fs from "node:fs"
import path from "node:path"

import type { Subprocess } from "bun"

import { PAGES } from "./pages"
import { seedSandbox } from "./sandbox"

const REPO = path.resolve(import.meta.dir, "..", "..")
const API_URL = "http://localhost:4000"
const WEB_URL = "http://localhost:3000"

const flag = (name: string) => process.argv.indexOf(name)
const dirAt = flag("--dir")
const keep = flag("--keep") !== -1
const sb = await seedSandbox(dirAt === -1 ? undefined : process.argv[dirAt + 1])

// Only what the API needs to boot; Bun's SQL client connects lazily and no dashboard route reaches the database, so a dummy URL is enough.
const apiEnv = {
  ...sb.env,
  BETTER_AUTH_SECRET: "inscope-e2e-secret-not-for-production",
  HONO_APP_URL: API_URL,
  HONO_TRUSTED_ORIGINS: WEB_URL,
  NODE_ENV: "local",
  PORT: "4000",
  POSTGRES_URL: "postgres://inscope:inscope@127.0.0.1:1/inscope",
}

// The web process reads nothing of the machine's inscope state, so it keeps the developer's environment and only learns where the API is.
const webEnv = {
  ...process.env,
  NEXT_PUBLIC_API_URL: API_URL,
  NEXT_PUBLIC_APP_URL: WEB_URL,
  PORT: "3000",
  PORTLESS: "0",
}

// each server runs in its own process group, so stopping it also stops what it spawned (`bun run dev:app` reaches `next dev` through two wrappers)
const children: Subprocess[] = []
const stop = () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stop()
    process.exit(130)
  })

const start = (
  cwd: string,
  cmd: string[],
  env: Record<string, string | undefined>,
  log: string,
) => {
  const out = Bun.file(path.join(sb.root, log))
  const child = Bun.spawn(cmd, {
    cwd: path.join(REPO, cwd),
    detached: true,
    env,
    stderr: out,
    stdout: out,
  })
  children.push(child)
  return child
}

const waitFor = async (url: string, seconds: number) => {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" })
      if (res.status < 500) return
    } catch {
      // not listening yet
    }
    await Bun.sleep(500)
  }
  throw new Error(`${url} did not come up within ${seconds}s; see the logs in ${sb.root}`)
}

try {
  start("api/hono", ["bun", "src/index.ts"], apiEnv, "api.log")
  start("web/next", ["bun", "run", "dev:app"], webEnv, "web.log")
  await waitFor(`${API_URL}/api/health`, 60)
  // the first request compiles each route under next dev, so warm them before a test or a browser times out on it
  for (const page of PAGES) await waitFor(`${WEB_URL}${page.path}`, 240)

  if (keep) {
    console.log(`sandbox ${sb.root}\napi ${API_URL}\nweb ${WEB_URL}\nCtrl-C to stop`)
    await new Promise(() => {})
  }

  const suites = [
    "tests/api/hono/src/routers/inscope.e2e.test.ts",
    "tests/web/next/src/app/(inscope)/layout.e2e.test.ts",
  ]
  // bun test runs whatever of these it finds and says nothing of the rest, so a moved suite would silently drop out
  for (const file of suites)
    if (!(await Bun.file(path.join(REPO, file)).exists()))
      throw new Error(`no e2e suite at ${file}`)
  const suite = Bun.spawn(["bun", "test", ...suites, "--timeout", "60000"], {
    cwd: REPO,
    env: {
      ...process.env,
      E2E_API_URL: API_URL,
      E2E_INSCOPE_SANDBOX: sb.root,
      E2E_WEB_URL: WEB_URL,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await suite.exited
  stop()
  if (code === 0) fs.rmSync(sb.root, { recursive: true, force: true })
  else console.error(`logs and sandbox kept in ${sb.root}`)
  process.exit(code)
} catch (err) {
  stop()
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
