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

// Set or clear inscope's one managed key, `permissions.defaultMode`, while
// preserving everything else the login wrote to settings.json. Turning bypass off
// only removes the key when it is exactly inscope's value, so a mode a user set by
// hand is left alone. Pure (doc in, doc out) so it is unit-testable.
export const mergeBypassSettings = (
  doc: Record<string, any>,
  bypass: boolean,
): Record<string, any> => {
  const next = { ...doc }
  const perms: Record<string, any> = {
    ...(next.permissions && typeof next.permissions === "object" ? next.permissions : {}),
  }
  if (bypass) perms.defaultMode = BYPASS_MODE
  else if (perms.defaultMode === BYPASS_MODE) delete perms.defaultMode
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
// which inscope never writes). Never creates an empty settings.json: with bypass
// off and no existing file, there is nothing to write.
export const applyBypass = (ws: Workspace, bypass: boolean) => {
  if (!ws.isolate) return
  const file = inscopeSettingsPath(ws)
  const existed = fs.existsSync(file)
  const next = mergeBypassSettings(readSettings(file), bypass)
  if (!existed && Object.keys(next).length === 0) return
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
