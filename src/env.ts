import os from "node:os"
import path from "node:path"

export const home = () => os.homedir()

export const configHome = () =>
  process.env.XDG_CONFIG_HOME?.trim() || path.join(home(), ".config")

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
