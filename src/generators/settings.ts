import fs from "node:fs"
import path from "node:path"

import type { Config, Workspace } from "@/config"
import { baseClaudeDir, inscopeDirPath } from "@/generators/isolate"
import { writeFileAtomic } from "@/io"
import type { Route } from "@/proxy"
import { shSingleQuote } from "@/secrets"

// A login's own Claude user-scope settings live at the root of its config dir (an
// isolated workspace's `.inscope`, or the shared base), so what inscope writes there
// governs that login under any launcher (unlike a project `.claude/settings.json`,
// where bypassPermissions does not take effect and the session starts in Manual mode).
// Bypass is written only to isolated logins; routing through the proxy, to every login.
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

// The apiKeyHelper Claude runs (via the shell) at session start to fetch the proxy's
// client key; it prints the bare key, which Claude sends as both
// `Authorization: Bearer` and `x-api-key`. Looking up by service alone (no
// `-a "$USER"`) keeps it free of shell variables. A missing key makes `security`
// exit nonzero, so Claude reports the failing helper instead of falling back to
// the login's OAuth token. The service is validated and single-quoted. The prefix
// and suffix are the one definition of the format, used both to build inscope's
// helper and to recognize it when clearing.
const HELPER_PREFIX = "security find-generic-password -s "
const HELPER_SUFFIX = " -w"

export const proxyKeyHelper = (service: string) =>
  `${HELPER_PREFIX}${shSingleQuote(service)}${HELPER_SUFFIX}`

const isInscopeKeyHelper = (v: unknown) =>
  typeof v === "string" && v.startsWith(`${HELPER_PREFIX}'`) && v.endsWith(`'${HELPER_SUFFIX}`)

// Routing a login through the proxy takes over its `apiKeyHelper` and
// `env.ANTHROPIC_BASE_URL`. When either is already set and not by inscope (your own
// key helper, or a base URL without inscope's helper beside it), say so instead of
// overwriting it. Null when the login is free to route.
export const foreignRouting = (doc: Record<string, any>): string | null => {
  if (doc.apiKeyHelper !== undefined && !isInscopeKeyHelper(doc.apiKeyHelper))
    return "already sets its own apiKeyHelper"
  if (doc.env?.ANTHROPIC_BASE_URL !== undefined && !isInscopeKeyHelper(doc.apiKeyHelper))
    return "already sets its own env.ANTHROPIC_BASE_URL"
  return null
}

// Set or clear inscope's routing keys, `env.ANTHROPIC_BASE_URL` and `apiKeyHelper`,
// preserving everything else. Clearing removes the pair only when the helper is
// inscope's own (a hand-set helper and its base URL are left alone), and drops an
// `env` object it emptied. Pure, like mergeBypassSettings; callers check
// foreignRouting first, so setting never overwrites a hand-set pair.
export const mergeRouting = (
  doc: Record<string, any>,
  route: Route | undefined,
): Record<string, any> => {
  const next = { ...doc }
  const cur = next.env
  const env: Record<string, any> = {
    ...(cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}),
  }
  if (route) {
    env.ANTHROPIC_BASE_URL = route.url
    next.apiKeyHelper = proxyKeyHelper(route.keychain)
  } else if (isInscopeKeyHelper(next.apiKeyHelper)) {
    delete next.apiKeyHelper
    delete env.ANTHROPIC_BASE_URL
  }
  if (Object.keys(env).length) next.env = env
  else delete next.env
  return next
}

// A login dir's settings.json as an object ({} when there is none). One that does not
// parse throws: inscope never clobbers a settings.json it cannot read.
const readSettings = (dir: string): Record<string, any> => {
  const file = path.join(dir, "settings.json")
  if (!fs.existsSync(file)) return {}
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"))
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {}
  } catch {
    throw new Error(
      `${file} is not valid JSON; fix or remove it, then re-run inscope (left it untouched)`,
    )
  }
}

// The same, for checks that report rather than write: an unreadable file reads as empty.
const peekSettings = (dir: string): Record<string, any> => {
  try {
    return readSettings(dir)
  } catch {
    return {}
  }
}

// Reconcile one login dir's settings.json through a pure merge, preserving everything
// the login wrote itself. Claude Code writes this file too, so it is rewritten only
// when the merge changes something.
const reconcileAt = (dir: string, merge: (doc: Record<string, any>) => Record<string, any>) => {
  const file = path.join(dir, "settings.json")
  const existed = fs.existsSync(file)
  const cur = readSettings(dir)
  const next = merge(cur)
  if (existed && JSON.stringify(next) === JSON.stringify(cur)) return
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

// Reconcile an isolated workspace's own login settings to the desired bypass state. A
// no-op for a non-isolated workspace (bypass is never written to the shared ~/.claude).
export const applyBypass = (ws: Workspace, bypass: boolean) => {
  if (!ws.isolate) return
  applyBypassAt(inscopeDirPath(ws), bypass)
}

// Every login dir inscope routes: the shared base login and each isolated workspace's.
const routedDirs = (cfg: Config): string[] => [
  baseClaudeDir(),
  ...cfg.workspaces.filter((w) => w.isolate).map(inscopeDirPath),
]

// Check every routed login before apply writes anything: one with a settings.json
// that does not parse, or with a key helper or base URL of its own, stops apply up
// front. Only when routing is on (clearing never touches a hand-set pair).
export const preflightRouting = (cfg: Config, route: Route | undefined) => {
  if (!route) return
  for (const dir of routedDirs(cfg)) {
    const why = foreignRouting(readSettings(dir))
    if (why)
      throw new Error(
        `${path.join(dir, "settings.json")} ${why}; remove it to send this login through the proxy (left it untouched)`,
      )
  }
}

// Route every login through `route` (the proxy), or clear inscope's routing keys from
// every login when there is none.
export const applyRouting = (cfg: Config, route: Route | undefined) => {
  for (const dir of routedDirs(cfg)) {
    if (!route && !fs.existsSync(path.join(dir, "settings.json"))) continue
    reconcileAt(dir, (doc) => mergeRouting(doc, route))
  }
}

// Whether a login dir already routes through `route` (URL and helper both as apply writes
// them), and whether it still carries inscope's helper with no proxy configured; doctor
// flags both kinds of drift.
export const routedAt = (dir: string, route: Route): boolean => {
  const doc = peekSettings(dir)
  return (
    doc?.env?.ANTHROPIC_BASE_URL === route.url &&
    doc?.apiKeyHelper === proxyKeyHelper(route.keychain)
  )
}

export const staleRoutingAt = (dir: string): boolean =>
  isInscopeKeyHelper(peekSettings(dir).apiKeyHelper)

// The `permissions.defaultMode` an isolated login's settings.json declares, if any.
export const loginDefaultMode = (ws: Workspace): string | undefined => {
  const mode = peekSettings(inscopeDirPath(ws)).permissions?.defaultMode
  return typeof mode === "string" ? mode : undefined
}

// Whether an isolated workspace's settings.json already declares inscope's bypass
// mode; used by doctor to flag drift (bypass configured but not yet applied).
export const hasBypassSetting = (ws: Workspace): boolean => loginDefaultMode(ws) === BYPASS_MODE

// Whether the login also carries the pre-seeded bypass dialog acceptance. A login
// written by an older inscope has only defaultMode; doctor flags that so a re-run
// of apply can seed it (without it, Claude shows the dialog on first interactive
// launch and refuses background sessions until then).
export const hasBypassAcceptance = (ws: Workspace): boolean =>
  peekSettings(inscopeDirPath(ws))[BYPASS_ACCEPTANCE_KEY] === true
