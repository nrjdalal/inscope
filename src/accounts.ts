import fs from "node:fs"
import path from "node:path"

import type { Workspace } from "@/config"
import { accountDir, accountsDir } from "@/env"
import {
  gitignorePath,
  inscopeDirPath,
  inscopeSignedIn,
  renderGitignore,
} from "@/generators/isolate"
import { readFileOrEmpty, writeFileAtomic } from "@/io"

// The account pool: a workspace can draw from several named Claude logins. Each
// account is a real Claude config dir in the registry (~/.config/inscope/accounts/
// <name>), signed in once and reusable across workspaces. A pooled workspace's
// `<path>/.inscope` is a SYMLINK to the active account, so switching accounts is one
// atomic re-point of that link, the generated hook (which bakes `<path>/.inscope`)
// never changes. Pure fs; no Runner.

export const poolFor = (ws: Workspace): string[] => ws.accounts ?? []

export const isPooled = (ws: Workspace): boolean => (ws.accounts?.length ?? 0) > 0

// Every account dir present in the registry (each holds, or will hold, a login).
export const listRegistry = (): string[] => {
  try {
    return fs
      .readdirSync(accountsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

export const isSignedIn = (name: string): boolean => inscopeSignedIn(accountDir(name))

// The next account in pool order after `after` (wrap-around) that is signed in, or
// null if none is. Phase 1's auto-switch target; Phase 2 additionally skips capped
// accounts (see usage.ts).
export const nextSignedIn = (ws: Workspace, after: string | null): string | null => {
  const pool = poolFor(ws)
  if (!pool.length) return null
  const start = after ? pool.indexOf(after) : -1
  for (let i = 1; i <= pool.length; i++) {
    const name = pool[(((start + i) % pool.length) + pool.length) % pool.length]
    if (isSignedIn(name)) return name
  }
  return null
}

// The account a pooled workspace's `.inscope` symlink currently points at, or null
// when `.inscope` is not a symlink into the registry for an account still in the
// pool (unmigrated real dir, dangling, foreign, or a removed account).
export const activeAccount = (ws: Workspace): string | null => {
  const link = inscopeDirPath(ws)
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null
    const target = path.resolve(path.dirname(link), fs.readlinkSync(link))
    if (path.dirname(target) !== accountsDir()) return null
    const name = path.basename(target)
    return poolFor(ws).includes(name) ? name : null
  } catch {
    return null
  }
}

// Atomically point (or re-point) `<path>/.inscope` at accountDir(name), via a temp
// symlink + rename, so a concurrent reader never sees a torn link. The account dir
// is created if missing; callers validate name ∈ pool first.
export const repointSymlink = (ws: Workspace, name: string): void => {
  const link = inscopeDirPath(ws)
  fs.mkdirSync(accountDir(name), { recursive: true })
  const tmp = `${link}.inscope-${process.pid}.tmp`
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}
  fs.symlinkSync(accountDir(name), tmp)
  fs.renameSync(tmp, link)
}

// Ensure `<path>/.inscope` is a symlink to an account in the pool. Migrates a legacy
// real `.inscope` dir into the registry on first pool-apply (preserving the login's
// inode via rename), and self-heals a dangling/foreign link. Returns the active
// account name, or null if a legacy dir could not be adopted (a live login already
// occupies the target account, caller should warn).
export const ensureActiveSymlink = (ws: Workspace): string | null => {
  const first = poolFor(ws)[0]
  if (!first) return null
  const link = inscopeDirPath(ws)
  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(link)
  } catch {
    stat = undefined
  }

  if (stat?.isSymbolicLink()) {
    const active = activeAccount(ws) // valid link into the pool: keep it
    if (active) return active
    repointSymlink(ws, first) // dangling/foreign/removed-account: re-point
    return first
  }

  if (stat?.isDirectory()) {
    // Legacy real `.inscope` (a live login): adopt it as the first account by moving
    // the whole dir (rename preserves the inode, so an in-flight session survives).
    const dest = accountDir(first)
    if (fs.existsSync(dest) && inscopeSignedIn(dest)) return null // occupied: don't clobber
    fs.mkdirSync(accountsDir(), { recursive: true })
    fs.rmSync(dest, { recursive: true, force: true }) // drop an empty placeholder
    fs.renameSync(link, dest)
    repointSymlink(ws, first)
    return first
  }

  repointSymlink(ws, first) // missing: create the account dir + symlink
  return first
}

// Scaffold every account dir in the pool, ensure the active symlink, and gitignore
// it (symlink-safe entry). The pool counterpart of applyIsolation, called from apply.
export const ensurePool = (ws: Workspace): string | null => {
  for (const name of poolFor(ws)) fs.mkdirSync(accountDir(name), { recursive: true })
  const active = ensureActiveSymlink(ws)
  const gi = gitignorePath(ws)
  const current = readFileOrEmpty(gi)
  const next = renderGitignore(current, true)
  if (next !== current) writeFileAtomic(gi, next)
  return active
}
