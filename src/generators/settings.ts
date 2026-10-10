import fs from "node:fs"
import path from "node:path"

import { accountDir } from "@/accounts"
import type { Config, Gateway, Workspace } from "@/config"
import { hasOwnLogin, inscopeDirPath, loginDir } from "@/generators/isolate"
import { writeFileAtomic } from "@/io"
import { shSingleQuote } from "@/secrets"

// A login's own Claude user-scope settings live at the root of its config dir (an
// isolated workspace's `.inscope`, or an account's dir), so `permissions.defaultMode`
// there governs that login under any launcher (unlike a project
// `.claude/settings.json`, where bypassPermissions does not take effect and the
// session starts in Manual mode).
// Never the shared base: inscope does not write ~/.claude, so a workspace without its
// own login still maps to its (unused) `.inscope`, which applyBypass never writes.
export const inscopeSettingsPath = (ws: Workspace) =>
  path.join(ws.account ? accountDir(ws.account) : inscopeDirPath(ws), "settings.json")

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

// The apiKeyHelper Claude runs (via the shell) at session start to fetch the
// gateway's client key; it prints the bare key, which Claude sends as both
// `Authorization: Bearer` and `x-api-key`. Looking up by service alone (no
// `-a "$USER"`) keeps it free of shell variables. A missing key makes `security`
// exit nonzero, so Claude reports the failing helper instead of falling back to
// the login's OAuth token. The service is validated and single-quoted. The prefix
// and suffix are the one definition of the format, used both to build inscope's
// helper and to recognize it when clearing.
const HELPER_PREFIX = "security find-generic-password -s "
const HELPER_SUFFIX = " -w"

export const gatewayKeyHelper = (service: string) =>
  `${HELPER_PREFIX}${shSingleQuote(service)}${HELPER_SUFFIX}`

const isInscopeKeyHelper = (v: unknown) =>
  typeof v === "string" && v.startsWith(`${HELPER_PREFIX}'`) && v.endsWith(`'${HELPER_SUFFIX}`)

// Set or clear inscope's gateway keys, `env.ANTHROPIC_BASE_URL` and
// `apiKeyHelper`, preserving everything else. Clearing removes the pair only when
// the helper is inscope's own (a hand-set helper and its base URL are left
// alone), and drops an `env` object it emptied. Pure, like mergeBypassSettings.
export const mergeGatewaySettings = (
  doc: Record<string, any>,
  gw: Gateway | undefined,
): Record<string, any> => {
  const next = { ...doc }
  const cur = next.env
  const env: Record<string, any> = {
    ...(cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}),
  }
  if (gw) {
    env.ANTHROPIC_BASE_URL = gw.url
    next.apiKeyHelper = gatewayKeyHelper(gw.keychain)
  } else if (isInscopeKeyHelper(next.apiKeyHelper)) {
    delete next.apiKeyHelper
    delete env.ANTHROPIC_BASE_URL
  }
  if (Object.keys(env).length) next.env = env
  else delete next.env
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

// Reconcile one login dir's settings.json through a pure merge, preserving everything
// the login wrote itself.
const reconcileAt = (dir: string, merge: (doc: Record<string, any>) => Record<string, any>) => {
  const file = path.join(dir, "settings.json")
  const existed = fs.existsSync(file)
  const next = merge(readSettings(file))
  // Nothing left to declare (a bypass-only file just turned off, or there was
  // nothing to write): remove an existing file rather than leave `{}` behind, and
  // never create an empty one.
  if (Object.keys(next).length === 0) {
    if (existed) fs.rmSync(file, { force: true })
    return
  }
  writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n")
}

const applyBypassAt = (dir: string, bypass: boolean) =>
  reconcileAt(dir, (doc) => mergeBypassSettings(doc, bypass))

// Reconcile a workspace's own login settings (its `.inscope`, or its account's dir) to
// the desired bypass state. A no-op for a non-isolated workspace (it runs on the shared
// ~/.claude, which inscope never writes).
export const applyBypass = (ws: Workspace, bypass: boolean) => {
  if (!hasOwnLogin(ws)) return
  applyBypassAt(loginDir(ws), bypass)
}

// Bypass is a property of each login inscope owns, so every account login gets it,
// including one no workspace uses yet (it is one `account:` edit away from being used).
// Only an account that has been signed in (its dir exists) is touched.
export const applyAccountsBypass = (cfg: Config) => {
  for (const acc of cfg.accounts ?? []) {
    const dir = accountDir(acc.name)
    if (fs.existsSync(dir)) applyBypassAt(dir, cfg.bypass ?? false)
  }
}

// Reconcile an isolated workspace's login to its configured gateway, or clear
// inscope's gateway keys when it has none. Only isolated logins carry a gateway.
export const applyGateway = (ws: Workspace) => {
  if (!ws.isolate) return
  reconcileAt(inscopeDirPath(ws), (doc) => mergeGatewaySettings(doc, ws.gateway))
}

const loginSettings = (ws: Workspace): Record<string, any> | undefined => {
  try {
    const doc = JSON.parse(fs.readFileSync(inscopeSettingsPath(ws), "utf8"))
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : undefined
  } catch {
    return undefined
  }
}

// The `permissions.defaultMode` an isolated login's settings.json declares, if any.
export const loginDefaultMode = (ws: Workspace): string | undefined => {
  const mode = loginSettings(ws)?.permissions?.defaultMode
  return typeof mode === "string" ? mode : undefined
}

// Whether an isolated login already routes through the workspace's configured
// gateway (URL and helper both as apply writes them); doctor flags drift.
export const hasGatewaySetting = (ws: Workspace): boolean => {
  const doc = loginSettings(ws)
  return Boolean(
    ws.gateway &&
    doc?.env?.ANTHROPIC_BASE_URL === ws.gateway.url &&
    doc?.apiKeyHelper === gatewayKeyHelper(ws.gateway.keychain),
  )
}

// Whether an isolated login still carries inscope's gateway helper after the
// gateway was removed from config (apply clears it).
export const hasStaleGatewaySetting = (ws: Workspace): boolean =>
  !ws.gateway && isInscopeKeyHelper(loginSettings(ws)?.apiKeyHelper)

// Whether an isolated workspace's settings.json already declares inscope's bypass
// mode; used by doctor to flag drift (bypass configured but not yet applied).
export const hasBypassSetting = (ws: Workspace): boolean => loginDefaultMode(ws) === BYPASS_MODE

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
