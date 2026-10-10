// Run the Anthropic Messages emulator standalone for end-to-end checks with the real
// Claude Code CLI. Usage: bun test/support/serve-anthropic.ts <port> <log.jsonl> key=label[:quota]...
// Every request is appended to the log as JSON; Ctrl-C (or SIGTERM) stops it.
import fs from "node:fs"

import { startMessagesEmulator } from "./anthropic-messages-emulator"

const [port, log, ...specs] = process.argv.slice(2)
const accounts = Object.fromEntries(
  specs.map((s) => {
    const [key, rest] = s.split("=")
    const [label, quota] = rest.split(":")
    return [key, { label, ...(quota ? { quota: Number(quota) } : {}) }]
  }),
)
const emu = await startMessagesEmulator(accounts, { port: Number(port) })
console.log(`anthropic emulator on ${emu.url}`)
let seen = 0
setInterval(() => {
  const reqs = emu.requests()
  for (; seen < reqs.length; seen++) fs.appendFileSync(log, JSON.stringify(reqs[seen]) + "\n")
}, 200)
const stop = async () => {
  await emu.close()
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
