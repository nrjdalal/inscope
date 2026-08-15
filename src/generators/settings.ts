import fs from "node:fs"
import path from "node:path"

import type { Workspace } from "@/config"
import { inscopeDirPath } from "@/generators/isolate"
import { writeFileAtomic } from "@/io"

// An isolated workspace's own Claude user-scope settings live at the root of its
// config dir, so `permissions.defaultMode` there governs that login under any
// launcher (unlike a project `.claude/settings.json`, where bypassPermissions is
// ignored).
export const inscopeSettingsPath = (ws: Workspace) => path.join(inscopeDirPath(ws), "settings.json")

const BYPASS_MODE = "bypassPermissions"

// Claude Code's one-time "accept responsibility" dialog for bypassPermissions
// records its acceptance in the login's own settings.json under this key (since
// ~v2.1.223; older versions kept `bypassPermissionsModeAccepted` in .claude.json,
// which Claude migrates). Pre-seeding it means a fresh isolated login starts
// bypassed without the interactive dialog, and headless/background sessions are
// not refused on a login that has never been opened interactively.
export const BYPASS_ACCEPTANCE_KEY = "skipDangerousModePermissionPrompt"

// Set or clear inscope's managed keys, `permissions.defaultMode` and the bypass
// dialog acceptance, while preserving everything else the login wrote to
// settings.json. Turning bypass off only removes the mode when it is exactly
// inscope's value, so a mode a user set by hand is left alone; the acceptance
// flag grants nothing on its own (it only suppresses the one-time dialog) and a
// hand-accepted `true` is indistinguishable from inscope's, so it is removed
// symmetrically. Pure (doc in, doc out) so it is unit-testable.
export const mergeBypassSettings = (
  doc: Record<string, any>,
  bypass: boolean,
): Record<string, any> => {
  const next = { ...doc }
  const cur = next.permissions
  const perms: Record<string, any> = {
    ...(cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}),
  }
  if (bypass) {
    perms.defaultMode = BYPASS_MODE
    next[BYPASS_ACCEPTANCE_KEY] = true
  } else {
    if (perms.defaultMode === BYPASS_MODE) delete perms.defaultMode
    if (next[BYPASS_ACCEPTANCE_KEY] === true) delete next[BYPASS_ACCEPTANCE_KEY]
  }
  // Drop a permissions object we emptied so an off toggle leaves no `{}` noise.
  if (Object.keys(perms).length) next.permissions = perms
  else delete next.permissions
  return next
}

const readSettings = (file: string): Record<string, any> => {
  if (!fs.existsSync(file)) return {}
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"))
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {}
  } catch {
    // Never clobber a settings.json we cannot parse; abort rather than overwrite.
    throw new Error(
      `${file} is not valid JSON; fix or remove it, then re-run inscope (left it untouched)`,
    )
  }
}

// Reconcile an isolated workspace's `.inscope/settings.json` to the desired bypass
// state. A no-op for a non-isolated workspace (it runs on the shared ~/.claude,
// which inscope never writes).
export const applyBypass = (ws: Workspace, bypass: boolean) => {
  if (!ws.isolate) return
  const file = inscopeSettingsPath(ws)
  const existed = fs.existsSync(file)
  const next = mergeBypassSettings(readSettings(file), bypass)
  // Nothing left to declare (a bypass-only file just turned off, or there was
  // nothing to write): remove an existing file rather than leave `{}` behind, and
  // never create an empty one.
  if (Object.keys(next).length === 0) {
    if (existed) fs.rmSync(file, { force: true })
    return
  }
  writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n")
}

// Whether an isolated workspace's settings.json already declares inscope's bypass
// mode; used by doctor to flag drift (bypass configured but not yet applied).
export const hasBypassSetting = (ws: Workspace): boolean => {
  try {
    const doc = JSON.parse(fs.readFileSync(inscopeSettingsPath(ws), "utf8"))
    return doc?.permissions?.defaultMode === BYPASS_MODE
  } catch {
    return false
  }
}

// Whether the login also carries the pre-seeded bypass dialog acceptance. A login
// written by an older inscope has only defaultMode; doctor flags that so a re-run
// of apply can seed it (without it, Claude shows the dialog on first interactive
// launch and refuses background sessions until then).
export const hasBypassAcceptance = (ws: Workspace): boolean => {
  try {
    const doc = JSON.parse(fs.readFileSync(inscopeSettingsPath(ws), "utf8"))
    return doc?.[BYPASS_ACCEPTANCE_KEY] === true
  } catch {
    return false
  }
}
