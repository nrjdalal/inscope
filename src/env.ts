import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Honor $HOME (the POSIX home, and what shells use) before falling back to the
// OS lookup. This mirrors configHome() trusting $XDG_CONFIG_HOME, and is what
// lets a test point HOME at a sandbox: os.homedir() ignores a runtime
// process.env.HOME change (notably under Bun), so without this the zshrc and
// gitconfig writes would escape the sandbox onto the real dotfiles.
export const home = () => process.env.HOME?.trim() || os.homedir()

export const configHome = () => process.env.XDG_CONFIG_HOME?.trim() || path.join(home(), ".config")

export const expandTilde = (p: string) => {
  if (p === "~") return home()
  if (p.startsWith("~/")) return path.join(home(), p.slice(2))
  return p
}

export const contractTilde = (p: string) => {
  const abs = expandTilde(p)
  const h = home()
  if (abs === h) return "~"
  if (abs.startsWith(h + path.sep)) return "~/" + abs.slice(h.length + 1)
  return abs
}

export const resolveAbsolute = (p: string) => path.resolve(expandTilde(p))

export const inscopeHome = () => path.join(configHome(), "inscope")

// The registry of named Claude logins a pooled workspace can switch between. Each
// account is a real Claude config dir under ~/.config/inscope/accounts/<name>; a
// pooled workspace's `.inscope` is a symlink to the active one (see accounts.ts).
export const accountsDir = () => path.join(inscopeHome(), "accounts")

export const accountDir = (name: string) => path.join(accountsDir(), name)

export const configPath = () => path.join(inscopeHome(), "inscope.json")

export const hookPath = () => path.join(inscopeHome(), "inscope.zsh")

export const gitIncludeDir = () => path.join(inscopeHome(), "git")

export const gitconfigPath = () => path.join(home(), ".gitconfig")

export const zshrcPath = () => path.join(home(), ".zshrc")

// The installed inscope package root: the directory holding this package's
// package.json (and, when shipped, `skills/`). Resolved by walking up from this
// module to the nearest package.json named "inscope", so it works both from the
// bundled dist and from source in dev, wherever the package is installed (global,
// npx cache, or nested node_modules). Used to locate the bundled self-skill.
export const packageRoot = (): string => {
  const start = path.dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
      if (pkg?.name === "inscope") return dir
    } catch {
      // no package.json here (or unreadable): keep walking up.
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  // Fallback: two levels up from the module (dist/index.mjs -> package root).
  return path.dirname(path.dirname(start))
}
