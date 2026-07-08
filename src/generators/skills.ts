import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import {
  type Config,
  type NormalizedSkill,
  normalizeSkill,
  RESERVED_SKILL_NAME,
  type Workspace,
} from "@/config"
import { home, inscopeHome, packageRoot, resolveAbsolute } from "@/env"
import { INSCOPE_DIR, inscopeDirPath } from "@/generators/isolate"
import { readBlock, removeBlock } from "@/managed-block"
import { defaultRunner, type Runner } from "@/secrets"

// The non-isolated base login dir, matching the hook's `${__inscope_base_ccd:-$HOME/.claude}`:
// a user's global CLAUDE_CONFIG_DIR when they set one, else ~/.claude. The current
// process's CLAUDE_CONFIG_DIR counts only when it is NOT one of inscope's own isolated
// dirs (the shell may sit in an isolated workspace, whose hook exported that dir), so a
// non-isolated workspace's skills always land on the base, never a sibling isolated login.
const baseClaudeDir = (): string => {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  return env && path.basename(env) !== INSCOPE_DIR ? env : path.join(home(), ".claude")
}

// The personal skills dir Claude reads for a workspace. A skill materialized here
// is personal scope: Claude lists it in the `/` menu and loads it in every project
// of that login, with no `--add-dir` and no per-repo linking (so it works under any
// launcher, cmux included). An isolated workspace has its own login, so its skills
// stay private in `<ws>/.inscope/skills`; a non-isolated one shares the base login's
// `skills` dir with every other non-isolated workspace, because they share one config
// dir and therefore cannot be scoped apart.
export const skillsDir = (ws: Workspace): string =>
  ws.isolate ? path.join(inscopeDirPath(ws), "skills") : path.join(baseClaudeDir(), "skills")

// One shared content cache for every workspace. Each git source is cloned exactly
// once here, keyed by host/owner/repo (plus @ref when pinned), so five workspaces
// linking the same source store it a single time and `skill update` refreshes them
// all at once. Workspaces hold only symlinks into this tree.
export const skillsCacheRoot = () => path.join(inscopeHome(), "skills-cache")

// The bundled self-skill: a guide that teaches Claude how to drive inscope. It
// ships in the package under skills/inscope and is linked into every workspace by
// default (opt out per workspace with selfSkill: false). "inscope" is reserved as
// a skill name so it never collides with a user-declared skill.
export const SELF_SKILL_NAME = RESERVED_SKILL_NAME
export const selfSkillSource = () => path.join(packageRoot(), "skills", SELF_SKILL_NAME)

// The self-skill's stable home in the shared cache. Workspaces link here rather
// than directly at the package dir, so the link stays valid even under `npx`,
// whose package dir npm may garbage-collect out from under a symlink.
const selfSkillCacheDir = () => path.join(skillsCacheRoot(), SELF_SKILL_NAME)

// The bundled self-skill is available if it ships in the package or a prior apply
// already copied it into the cache. Shared by desiredSkillLinks and applySkills so
// doctor/diff and apply agree on whether it should be linked.
export const selfSkillAvailable = (): boolean =>
  fs.existsSync(path.join(selfSkillSource(), "SKILL.md")) ||
  fs.existsSync(path.join(selfSkillCacheDir(), "SKILL.md"))

// Copy the bundled self-skill into the cache (refreshing it, so it self-updates
// with inscope) and return that stable dir; fall back to an existing cache copy if
// the package no longer ships it (e.g. an npx dir already collected). Null only when
// neither is present.
const ensureSelfSkillCached = (): string | null => {
  const cacheDir = selfSkillCacheDir()
  const src = selfSkillSource()
  if (fs.existsSync(path.join(src, "SKILL.md"))) {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.cpSync(src, cacheDir, { recursive: true, force: true })
    return cacheDir
  }
  return fs.existsSync(path.join(cacheDir, "SKILL.md")) ? cacheDir : null
}

// Whether a workspace's `.claude/skills/<name>` resolves to a real skill dir (a
// symlink into an existing SKILL.md). Used by the CLI listing; doctor/diff compare
// the actual link target instead (see skillLinkTarget), to catch a re-point.
export const skillLinked = (ws: Workspace, name: string): boolean => {
  const link = path.join(skillsDir(ws), name)
  try {
    return fs.statSync(link).isDirectory() && fs.existsSync(path.join(link, "SKILL.md"))
  } catch {
    return false
  }
}

const san = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
// A sanitized ref can collide (feat/x and feat-x both sanitize to feat-x), so a
// munged ref gets a short hash of the original appended; a clean ref stays as-is
// (e.g. @main, @v1.2.3), which keeps common cache dirs readable.
const refSuffix = (ref?: string) => {
  if (!ref) return ""
  const s = san(ref)
  return s === ref ? `@${s}` : `@${s}-${createHash("sha1").update(ref).digest("hex").slice(0, 7)}`
}

// The git URL to clone for a git-backed skill, or null for a local source.
const gitUrlFor = (skill: NormalizedSkill): string | null => {
  if (skill.source.kind === "github") return `https://github.com/${skill.source.repo}.git`
  if (skill.source.kind === "git") return skill.source.url
  return null
}

// The cache directory for a git-backed skill's source repo (not the skill subdir).
// GitHub sources nest under github.com/<owner>/<repo>[@ref]; other git URLs under
// git/<sanitized-url>[@ref]. Pure and deterministic, so it is snapshot-testable.
export const cacheDirFor = (skill: NormalizedSkill): string => {
  const s = skill.source
  let rel: string
  if (s.kind === "github") {
    const [owner, repo] = s.repo.split("/")
    rel = path.join("github.com", san(owner), `${san(repo)}${refSuffix(skill.ref)}`)
  } else if (s.kind === "git") {
    const stripped = s.url.replace(/^[a-z]+:\/\//, "").replace(/\.git$/, "")
    const key = san(stripped)
    // Sanitizing can collapse distinct URLs (host/a-b vs host/a/b) onto one key, so
    // a munged key gets a short hash of the original url, as refSuffix does for refs.
    const hash =
      key === stripped ? "" : `-${createHash("sha1").update(s.url).digest("hex").slice(0, 7)}`
    rel = path.join("git", `${key}${hash}${refSuffix(skill.ref)}`)
  } else {
    // local sources are never cached; callers handle this kind before here.
    return resolveAbsolute(s.path)
  }
  return path.join(skillsCacheRoot(), rel)
}

// Clone a git source into the cache as shallowly as possible, if absent.
//
// - Floating (no pinned ref): a depth-1 single-branch clone, which keeps an
//   upstream so `skill update` can `git pull --ff-only`. A pinned ref is never
//   pulled, so its detached HEAD below is fine.
// - Pinned branch/tag: one depth-1 `--branch` clone.
// - Pinned commit sha (which `--branch` rejects): `init` + a depth-1 fetch of just
//   that commit, then a detached checkout. GitHub and most hosts serve a reachable
//   sha this way, so we avoid the full-history clone the old fallback did.
//
// `--no-tags` trims refs on every fetch. `--` guards the url/dir positionals; the
// ref is validated (no leading dash) upstream, so it is safe as a flag value. A
// failed pull (e.g. offline) is best-effort: the existing clone stays usable.
const ensureClone = (skill: NormalizedSkill, dir: string, run: Runner, update: boolean) => {
  const url = gitUrlFor(skill)
  if (!url) return
  if (fs.existsSync(path.join(dir, ".git"))) {
    if (update && !skill.ref) run("git", ["-C", dir, "pull", "--ff-only"])
    return
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })

  const clone = (extra: string[]) =>
    run("git", ["clone", "--depth", "1", "--no-tags", ...extra, "--", url, dir])

  if (!skill.ref) {
    const r = clone(["--single-branch"])
    if (r.status !== 0)
      throw new Error(`failed to clone ${url}: ${r.stderr.trim() || "git clone failed"}`)
    return
  }

  // A pinned branch or tag: one shallow clone at that ref.
  if (clone(["--branch", skill.ref]).status === 0) return

  // Otherwise the ref is a commit sha: shallow-fetch exactly that commit and detach.
  // `git init` creates `.git` before any content is fetched, so a failure partway
  // through would leave a `.git`-only dir that the guard above then treats as a
  // complete clone (never retrying). Clean the dir on any failure so the next apply
  // starts fresh. (The clone paths above self-clean their own partial dir.)
  try {
    for (const args of [
      ["init", "-q", dir],
      ["-C", dir, "remote", "add", "origin", url],
      ["-C", dir, "fetch", "--depth", "1", "--no-tags", "origin", skill.ref],
      ["-C", dir, "checkout", "-q", "--detach", "FETCH_HEAD"],
    ]) {
      const r = run("git", args)
      if (r.status !== 0)
        throw new Error(
          `failed to fetch ${skill.ref} from ${url}: ${r.stderr.trim() || "git fetch failed"}`,
        )
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

// The un-renamed dir that holds a skill's SKILL.md: the cache subdir for a git
// source, the resolved local path otherwise. Pure and deterministic.
const originalTarget = (skill: NormalizedSkill): string => {
  const root =
    skill.source.kind === "local" ? resolveAbsolute(skill.source.path) : cacheDirFor(skill)
  return skill.subdir ? path.join(root, skill.subdir) : root
}

// Resolve a skill to the absolute directory that holds its SKILL.md, cloning a git
// source into the cache first (or pulling it, with `update`). Local sources point
// straight at the path on disk. The subdir, when set, is appended to the source root.
export const resolveSkillDir = (
  skill: NormalizedSkill,
  run: Runner = defaultRunner,
  opts?: { update?: boolean },
): string => {
  if (skill.source.kind !== "local")
    ensureClone(skill, cacheDirFor(skill), run, opts?.update ?? false)
  return originalTarget(skill)
}

// Resolve a skill (cloning its source into the cache) and report whether its target
// dir actually holds a SKILL.md. Lets an explicit-subdir `add` validate up front,
// the way the discovery path does, instead of persisting a broken skill and warning
// only later at link time. Throws when the source will not resolve at all (a bad
// clone); returns false when it resolves but the subdir has no SKILL.md.
export const skillHasSkillMd = (skill: NormalizedSkill, run: Runner = defaultRunner): boolean =>
  fs.existsSync(path.join(resolveSkillDir(skill, run), "SKILL.md"))

// The `name:` value in a SKILL.md's frontmatter, or null when there is no readable
// SKILL.md / name line. Claude names the /command from this field, not the directory,
// which is why a custom `--name` has to rewrite it (see materializeRenamed).
const readFrontmatterName = (dir: string): string | null => {
  try {
    const m = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/)
    const nm = m?.[1].match(/^name:[ \t]*(.+?)[ \t]*$/m)
    return nm ? nm[1].replace(/^["']|["']$/g, "") : null
  } catch {
    return null
  }
}

// The cache dir for a rewritten copy of a skill whose inscope name differs from its
// own frontmatter name. Keyed by the original target + the new name, so two names for
// one source get distinct copies and a re-point gets a fresh one. Under the cache
// root, so a symlink to it is still inscope-owned (isOwnedLink) and prunes normally.
const renamedDirFor = (original: string, name: string): string =>
  path.join(
    skillsCacheRoot(),
    "renamed",
    `${san(name)}-${createHash("sha1").update(original).digest("hex").slice(0, 7)}`,
  )

// The absolute dir a declared skill's symlink should point at: the source itself,
// unless the inscope name differs from the skill's own frontmatter name -- then Claude
// would show the frontmatter name in the / menu, so inscope points at a rewritten copy
// (materialized in applySkills) whose name: matches. Reads the source's SKILL.md to
// decide, so it reflects the real target doctor/diff compare against.
export const skillTargetDir = (skill: NormalizedSkill): string => {
  const orig = originalTarget(skill)
  const fm = readFrontmatterName(orig)
  return fm !== null && fm !== skill.name ? renamedDirFor(orig, skill.name) : orig
}

// Replace the `name:` line inside a SKILL.md's leading frontmatter, body untouched.
const rewriteFrontmatterName = (raw: string, name: string): string => {
  const m = raw.match(/^---\n[\s\S]*?\n---/)
  if (!m) return raw
  return m[0].replace(/^name:[^\n]*/m, `name: ${name}`) + raw.slice(m[0].length)
}

// Copy a skill into a cache-local dir with its frontmatter name rewritten, so Claude
// shows inscope's chosen name in the / menu. Refreshed on `update` (or when missing);
// the stable key means a re-point makes a new copy and the old one is just cache litter.
const materializeRenamed = (srcDir: string, name: string, dest: string, refresh: boolean) => {
  if (!refresh && fs.existsSync(path.join(dest, "SKILL.md"))) return
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(srcDir, dest, { recursive: true })
  const md = path.join(dest, "SKILL.md")
  fs.writeFileSync(md, rewriteFrontmatterName(fs.readFileSync(md, "utf8"), name))
}

// The real target a skill symlink at `<dir>/<name>` points at, or null when the
// entry is missing, is not a symlink (a user-authored dir), or does not resolve to a
// SKILL.md. Comparing this to skillTargetDir surfaces both an unlinked skill and a
// still-pointing-at-the-old-source one.
export const skillLinkTargetAt = (dir: string, name: string): string | null => {
  const link = path.join(dir, name)
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null
    const target = fs.readlinkSync(link)
    return fs.existsSync(path.join(target, "SKILL.md")) ? target : null
  } catch {
    return null
  }
}

export const skillLinkTarget = (ws: Workspace, name: string): string | null =>
  skillLinkTargetAt(skillsDir(ws), name)

// What a workspace should have linked after an apply, as name -> intended target:
// the bundled self-skill (unless opted out) first, then each declared skill, deduped.
export const desiredSkillLinks = (ws: Workspace): { name: string; target: string }[] => {
  const out: { name: string; target: string }[] = []
  const seen = new Set<string>()
  if (ws.selfSkill !== false && selfSkillAvailable()) {
    out.push({ name: SELF_SKILL_NAME, target: selfSkillCacheDir() })
    seen.add(SELF_SKILL_NAME)
  }
  for (const spec of ws.skills ?? []) {
    const skill = normalizeSkill(spec)
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    out.push({ name: skill.name, target: skillTargetDir(skill) })
  }
  return out
}

// Skills found inside a resolved source dir: a SKILL.md at the root (the whole
// source is one skill) plus any `<dir>/SKILL.md` or `skills/<dir>/SKILL.md` one
// level down. `subdir` is relative to the source root ("" for a root skill).
// Deduped by subdir. Lets `skill add owner/repo` list and pick from a multi-skill
// repo, the way the `skills` CLI does.
export const discoverSkills = (root: string): { name: string; subdir: string }[] => {
  const out: { name: string; subdir: string }[] = []
  const seen = new Set<string>()
  const push = (name: string, subdir: string) => {
    if (seen.has(subdir)) return
    if (!fs.existsSync(path.join(root, subdir, "SKILL.md"))) return
    seen.add(subdir)
    out.push({ name, subdir })
  }
  // strip a `@ref` cache suffix so a pinned root source lists as "repo", not "repo@ref"
  push(path.basename(root).replace(/@[^/@]+$/, ""), "")
  for (const base of ["", "skills"]) {
    const scanDir = base ? path.join(root, base) : root
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(scanDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries)
      if (e.isDirectory()) push(e.name, base ? path.join(base, e.name) : e.name)
  }
  return out
}

// Point `<dir>/.claude/skills/<name>` at the resolved source dir. Idempotent (an
// already-correct symlink is left alone) and atomic (write a temp link, rename it
// over). Refuses to overwrite a real, user-authored directory or file: only a
// symlink inscope owns is ever replaced, mirroring the "touch only what we own"
// discipline of the managed dotfile blocks.
const linkSkill = (link: string, target: string) => {
  let existing: fs.Stats | null = null
  try {
    existing = fs.lstatSync(link)
  } catch {
    // missing: create below.
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      try {
        if (fs.readlinkSync(link) === target) return
      } catch {}
    } else {
      throw new Error(
        `refusing to overwrite ${link}: a non-symlink already exists there (pick a different skill name)`,
      )
    }
  }
  fs.mkdirSync(path.dirname(link), { recursive: true })
  const tmp = `${link}.inscope-${process.pid}.tmp`
  try {
    fs.rmSync(tmp, { force: true })
  } catch {}
  fs.symlinkSync(target, tmp)
  fs.renameSync(tmp, link)
}

// Whether `<dir>/<name>` is a skill symlink inscope created: a symlink whose target
// resolves under the shared skills cache. This is how pruning and migration touch
// only inscope's own links in a dir it shares with the user's hand-authored personal
// skills (real dirs, or symlinks pointing elsewhere), never removing those.
const isOwnedLink = (link: string): boolean => {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false
    const target = path.resolve(path.dirname(link), fs.readlinkSync(link))
    const root = skillsCacheRoot()
    return target === root || target.startsWith(root + path.sep)
  } catch {
    return false
  }
}

// The names of inscope-owned links currently in `dir`. Drives pruning and the diff.
export const ownedSkillNames = (dir: string): string[] => {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries.filter((n) => isOwnedLink(path.join(dir, n)))
}

// Remove every inscope-owned link in `dir` whose name is not in `keep`. Only cache
// -backed symlinks are candidates, so a user-authored dir/skill sharing the same
// `~/.claude/skills` is never touched. (A local-source link is not cache-backed, so
// it is left for `skill rm` to remove explicitly.)
const pruneOwned = (dir: string, keep: Set<string>) => {
  for (const name of ownedSkillNames(dir))
    if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true })
}

// Earlier versions linked skills into `<ws>/.claude/skills` and recorded them in a
// `.gitignore` "skills" block. Skills now live in the workspace's personal dir, so
// clean up the old location once: drop inscope-owned links there and the block.
// Idempotent, and a no-op when the old dir IS the new one (a home-rooted workspace).
const OLD_SKILLS_BLOCK_ID = "skills"
const migrateOldSkillsDir = (ws: Workspace) => {
  const wsRoot = resolveAbsolute(ws.path)
  const oldDir = path.join(wsRoot, ".claude", "skills")
  if (oldDir === skillsDir(ws)) return
  pruneOwned(oldDir, new Set())
  try {
    fs.rmdirSync(oldDir) // drop the now-empty old dir; throws (caught) if not empty
  } catch {}
  const gi = path.join(wsRoot, ".gitignore")
  if (readBlock(gi, OLD_SKILLS_BLOCK_ID) != null) removeBlock(gi, OLD_SKILLS_BLOCK_ID)
}

// Link one skill into `dir`, fail-soft: a source that will not resolve, a missing
// SKILL.md, or a name that collides with a real (user-authored) dir is warned and
// skipped, never thrown, so one bad skill cannot half-apply a dir or block others.
const linkOne = (
  dir: string,
  name: string,
  wsName: string,
  update: boolean,
  resolve: () => string,
) => {
  try {
    const srcDir = resolve()
    if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) throw new Error(`no SKILL.md at ${srcDir}`)
    // When the inscope name differs from the skill's own frontmatter name, link at a
    // rewritten copy so Claude shows the chosen /command name, not the upstream one.
    let target = srcDir
    const fm = readFrontmatterName(srcDir)
    if (fm !== null && fm !== name) {
      target = renamedDirFor(srcDir, name)
      materializeRenamed(srcDir, name, target, update)
    }
    linkSkill(path.join(dir, name), target)
  } catch (err) {
    console.error(
      `inscope: skill "${name}" in "${wsName}" not applied: ${err instanceof Error ? err.message : err}`,
    )
  }
}

type DesiredLink = { name: string; target: string; wsName: string; resolve: () => string }

// Materialize every workspace's declared skills into its personal skills dir
// (skillsDir): clone/resolve each source, symlink it in, then prune inscope-owned
// links no longer declared. Non-isolated workspaces share `~/.claude/skills`, so its
// desired set is the union across them; each isolated workspace owns its own dir.
// Idempotent; runs on every apply. `update` pulls floating git sources (off by
// default, so an apply only hits the network to clone a source not yet cached).
export const applySkills = (
  cfg: Config,
  run: Runner = defaultRunner,
  opts?: { update?: boolean },
) => {
  for (const ws of cfg.workspaces) migrateOldSkillsDir(ws)

  // The self-skill's cache copy is refreshed once and shared by every workspace that
  // links it (each personal dir gets its own symlink into this one cache dir).
  const selfDir = selfSkillAvailable() ? ensureSelfSkillCached() : null

  // Collect desired links keyed by target dir, so the shared `~/.claude/skills` is
  // the union of every non-isolated workspace and each isolated dir stands alone.
  // Every workspace's dir is seeded (even with no desired links), so a dir whose
  // skills were all removed still gets its now-orphaned owned links pruned below.
  const byDir = new Map<string, DesiredLink[]>()
  for (const ws of cfg.workspaces) if (!byDir.has(skillsDir(ws))) byDir.set(skillsDir(ws), [])
  const push = (dir: string, l: DesiredLink) => byDir.get(dir)?.push(l)
  for (const ws of cfg.workspaces) {
    const dir = skillsDir(ws)
    if (ws.selfSkill !== false && selfDir)
      push(dir, {
        name: SELF_SKILL_NAME,
        target: selfSkillCacheDir(),
        wsName: ws.name,
        resolve: () => selfDir,
      })
    for (const spec of ws.skills ?? []) {
      const skill = normalizeSkill(spec)
      if (skill.name === SELF_SKILL_NAME) continue // reserved for the self-skill
      push(dir, {
        name: skill.name,
        target: skillTargetDir(skill),
        wsName: ws.name,
        resolve: () => resolveSkillDir(skill, run, opts),
      })
    }
  }

  for (const [dir, links] of byDir) {
    const first = new Map<string, DesiredLink>()
    for (const l of links) {
      const prior = first.get(l.name)
      if (prior) {
        // Two non-isolated workspaces share `~/.claude/skills`; keep the first and
        // warn only when they disagree on the source (same name, different target).
        if (prior.target !== l.target)
          console.error(
            `inscope: skill "${l.name}" is declared by "${prior.wsName}" and "${l.wsName}" with different sources; keeping "${prior.wsName}"`,
          )
        continue
      }
      first.set(l.name, l)
      linkOne(dir, l.name, l.wsName, !!opts?.update, l.resolve)
    }
    // Prune by declared name (not link success): a still-declared skill whose link
    // just failed transiently keeps its existing link instead of being removed.
    pruneOwned(dir, new Set(first.keys()))
  }
}

// Remove a single managed skill symlink by name (never a real, user-authored dir).
// `skill rm` uses this before re-applying, because a local source is not cache-backed
// and so the apply-time prune (which keys on the cache) would miss it; the following
// apply re-links anything still declared, including another workspace that shares the
// same name in ~/.claude/skills.
export const unlinkSkillLink = (ws: Workspace, name: string) => {
  const link = path.join(skillsDir(ws), name)
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.rmSync(link, { force: true })
  } catch {}
}

// Tear down an isolated workspace's private skill links when it is removed from the
// config. A normal apply reconciles the shared `~/.claude/skills` from the remaining
// workspaces, but never revisits a removed isolated dir. Called by `inscope rm`.
export const removeSkills = (ws: Workspace) => {
  if (!ws.isolate) return
  pruneOwned(skillsDir(ws), new Set())
}
