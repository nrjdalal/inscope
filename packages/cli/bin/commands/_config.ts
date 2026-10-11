import { configExists, type Config, loadConfig } from "@/config"
import { name } from "~/package.json"

// The shared "you haven't set inscope up yet" guard. Every command except `add`
// (which creates the config) needs it, so keep the wording in one place. Exits
// non-zero, matching each command's prior inline guard.
export const requireConfigExists = (): void => {
  if (!configExists()) {
    console.error(`No config found. Run \`${name} add <path>\` first.`)
    process.exit(1)
  }
}

// Guard, then load: the common case where a command reads the config immediately.
export const requireConfig = (): Config => {
  requireConfigExists()
  return loadConfig()
}
