import os from "node:os"
import path from "node:path"

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

export const configPath = () => path.join(inscopeHome(), "inscope.json")

export const hookPath = () => path.join(inscopeHome(), "inscope.zsh")

export const gitIncludeDir = () => path.join(inscopeHome(), "git")

export const gitconfigPath = () => path.join(home(), ".gitconfig")

export const zshrcPath = () => path.join(home(), ".zshrc")
