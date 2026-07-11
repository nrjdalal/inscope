import { parseArgs } from "node:util"

import {
  absolutizeLocalSource,
  type Config,
  currentWorkspace,
  findWorkspace,
  loadConfig,
  type NormalizedSkill,
  normalizeSkill,
  renameSkillSpec,
  skillNameError,
  type SkillSpec,
  type Workspace,
} from "@/config"
import { contractTilde } from "@/env"
import {
  applySkills,
  discoverSkills,
  resolveSkillDir,
  SELF_SKILL_NAME,
  skillHasSkillMd,
  skillLinked,
  skillsDir,
  unlinkSkillLink,
} from "@/generators/skills"
import { defaultRunner } from "@/secrets"
import { requireConfigExists } from "~/bin/commands/_config"
import { green, isInteractive, orange, selectMany, yellow } from "~/bin/commands/_prompt"
import { persist } from "~/bin/commands/_workspace"
import { name } from "~/package.json"

const helpMessage = `Manage a workspace's Claude skills. A skill is symlinked from a
shared local cache into the workspace's personal Claude skills dir, so Claude lists it
in the / menu and loads it in every project. An isolated workspace keeps its skills
private to its own login; a normal one shares ~/.claude/skills. Everything auto-applies;
you do not run \`${name} apply\` yourself.

Usage:
  $ ${name} skill <command> [options]

Commands:
  add <source>        Add a skill (owner/repo#subdir, a git URL, or a local path)
  list                List a workspace's skills and whether they are linked (alias: ls)
  rename <old> <new>  Rename a skill (and its /command) in a workspace (alias: mv)
  rm <name>           Remove a skill from a workspace (alias: remove)
  update              Pull the latest for a workspace's floating git skills

Planned (not available yet): use, find, init

Options:
  -w, --workspace <label>  Target workspace (default: inferred from the current dir)
  -s, --skill <name>       (add) a specific skill from the source; repeatable, '*' for all
  -l, --list               (add) list the skills in the source without installing
      --all                (add) install every skill in the source
  -n, --name <name>        (add) install a single skill under a custom name (also its /command)
      --ref <ref>          (add) pin a branch, tag, or sha
  -y, --yes                (add) non-interactive: skip the skill picker
  -h, --help               Display help message`

// The workspace a subcommand acts on: an explicit --workspace wins, else the one
// containing the current dir (same match as the hook), else the sole workspace,
// else an error. Mirrors the fallbacks `edit`/`rm` already use.
const resolveWorkspace = (cfg: Config, flag?: string): Workspace => {
  if (flag) {
    const found = findWorkspace(cfg, flag)
    if (!found) {
      console.error(`No workspace matching "${flag}".`)
      process.exit(1)
    }
    return found
  }
  const here = currentWorkspace(cfg)
  if (here) return here
  if (cfg.workspaces.length === 1) return cfg.workspaces[0]
  console.error(`Run this inside a workspace, or pass --workspace <label>.`)
  process.exit(1)
}

// The compact "owner/repo#subdir@ref" source label shown in listings.
const sourceLabel = (s: NormalizedSkill): string => {
  const base =
    s.source.kind === "github"
      ? s.source.repo
      : s.source.kind === "git"
        ? s.source.url
        : s.source.path
  return `${base}${s.subdir ? `#${s.subdir}` : ""}${s.ref ? `@${s.ref}` : ""}`
}

const parse = (args: string[]) =>
  parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string", short: "w" },
      name: { type: "string", short: "n" },
      ref: { type: "string" },
      skill: { type: "string", short: "s", multiple: true },
      list: { type: "boolean", short: "l" },
      all: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
    args,
  })

// Parse an `add` source argument into a source string plus optional subdir and
// ref. Handles GitHub browser URLs copied from the address bar: a "tree" URL
// (owner/repo/tree/<ref>/<dir>) points at a directory, and a "blob" URL
// (owner/repo/blob/<ref>/<dir>/SKILL.md) points at a file, whose containing dir is
// the skill. Also handles the `#subdir` shorthand; a plain source passes through.
export const parseAddSource = (arg: string): { source: string; subdir?: string; ref?: string } => {
  const tree = arg.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/)
  if (tree) {
    const [, owner, repo, ref, sub] = tree
    return {
      source: `${owner}/${repo.replace(/\.git$/, "")}`,
      subdir: sub.replace(/\/+$/, ""),
      ref,
    }
  }
  const blob = arg.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
  if (blob) {
    const [, owner, repo, ref, file] = blob
    // A blob points at a file (e.g. .../SKILL.md); the skill is its directory, so
    // drop the trailing filename.
    return {
      source: `${owner}/${repo.replace(/\.git$/, "")}`,
      subdir: file.replace(/\/?[^/]+$/, ""),
      ref,
    }
  }
  const hash = arg.indexOf("#")
  if (hash >= 0) return { source: arg.slice(0, hash), subdir: arg.slice(hash + 1) }
  return { source: arg }
}

const skillAdd = async (args: string[]) => {
  const { positionals, values } = parse(args)
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const source = positionals[0]
  if (!source) {
    console.error(`Specify a skill source, e.g. \`${name} skill add owner/repo\`.`)
    process.exit(1)
  }

  const cfg = loadConfig()
  const ws = resolveWorkspace(cfg, values.workspace)

  // "inscope" is the reserved bundled self-skill (on by default). Adding it just
  // clears a prior opt-out rather than declaring a real source.
  if (source === SELF_SKILL_NAME) {
    if (ws.selfSkill !== false) {
      console.log(`\nThe inscope self-skill is already enabled for "${ws.name}".`)
      process.exit(0)
    }
    const enabled: Workspace = { ...ws }
    delete enabled.selfSkill
    persist(enabled)
    console.log(`\n✓ enabled the inscope self-skill for "${ws.name}"`)
    process.exit(0)
  }

  const parsed = parseAddSource(source)
  const ref = values.ref ?? parsed.ref
  // Absolutize a relative local source now (against the current cwd, which is what
  // the user means), so it stays valid when applyAll later re-links this workspace
  // from a different cwd.
  const sourceStr = absolutizeLocalSource(parsed.source)

  // A custom name or a pinned ref needs the object form; otherwise keep the terse
  // string shorthand (`source` or `source#subdir`).
  const buildSpec = (subdir: string | undefined, skillName?: string): SkillSpec => {
    if (skillName || ref) {
      return {
        ...(skillName ? { name: skillName } : {}),
        source: sourceStr,
        ...(subdir ? { path: subdir } : {}),
        ...(ref ? { ref } : {}),
      }
    }
    return subdir ? `${sourceStr}#${subdir}` : sourceStr
  }

  // Append the chosen specs (skipping the reserved name and ones already present),
  // then persist, which validates and applies (clone + link) in one step.
  const commit = (specs: SkillSpec[]) => {
    const have = new Set((ws.skills ?? []).map((sp) => normalizeSkill(sp).name))
    const toAdd: SkillSpec[] = []
    for (const spec of specs) {
      const n = normalizeSkill(spec).name
      if (n === SELF_SKILL_NAME) {
        console.log(`skipping "${n}": reserved for the bundled self-skill`)
        continue
      }
      if (have.has(n)) {
        console.log(`skipping "${n}": already in "${ws.name}"`)
        continue
      }
      have.add(n)
      toAdd.push(spec)
    }
    if (!toAdd.length) {
      console.log("\nNothing to add.")
      process.exit(0)
    }
    persist({ ...ws, skills: [...(ws.skills ?? []), ...toAdd] })
    console.log(`\n✓ added ${toAdd.length} skill${toAdd.length > 1 ? "s" : ""} to "${ws.name}"`)
    for (const spec of toAdd) {
      const n = normalizeSkill(spec)
      console.log(`  ${n.name.padEnd(18)}${orange(sourceLabel(n))}`)
    }
    console.log(
      `\nRelaunch \`claude\` from ${ws.path} to pick ${toAdd.length > 1 ? "them" : "it"} up.`,
    )
    process.exit(0)
  }

  // An explicit subdir (from #subdir or a tree URL) is a single, optionally named skill.
  if (parsed.subdir) {
    const spec = buildSpec(parsed.subdir, values.name)
    const norm = normalizeSkill(spec)
    // Resolve up front (clone + SKILL.md check) so a typo'd subdir fails here rather
    // than persisting a broken skill and printing a false "added" (the discovery path
    // below validates the same way).
    try {
      if (!skillHasSkillMd(norm)) {
        console.error(`No SKILL.md at ${sourceLabel(norm)}; check the subdir path.`)
        process.exit(1)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    commit([spec])
    return
  }

  // Otherwise resolve the source once and discover the skills inside it.
  let rootDir: string
  try {
    rootDir = resolveSkillDir(normalizeSkill(ref ? { source: sourceStr, ref } : sourceStr))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  const found = discoverSkills(rootDir)
  if (!found.length) {
    console.error(`No SKILL.md found in ${sourceStr}.`)
    process.exit(1)
  }

  if (values.list) {
    console.log(`\n${sourceStr}`)
    for (const f of found) console.log(`  ${f.name.padEnd(24)}${orange(f.subdir || "(root)")}`)
    process.exit(0)
  }

  const wanted = values.skill ?? []
  let chosen: { name: string; subdir: string }[]
  if (values.all || wanted.includes("*")) {
    chosen = found
  } else if (wanted.length) {
    chosen = wanted.map((w) => {
      const f = found.find((x) => x.name === w)
      if (!f) {
        console.error(`No skill named "${w}" in ${sourceStr} (try --list).`)
        process.exit(1)
      }
      return f
    })
  } else if (found.length === 1) {
    chosen = found
  } else if (isInteractive() && !values.yes) {
    const picked = await selectMany(
      `Select skills from ${sourceStr} (space toggles, enter confirms)`,
      found.map((f) => ({
        label: f.subdir ? `${f.name}  (${f.subdir})` : f.name,
        value: f.subdir,
        checked: false,
      })),
    )
    chosen = found.filter((f) => picked.includes(f.subdir))
    if (!chosen.length) {
      console.log("\nNothing selected.")
      process.exit(0)
    }
  } else {
    console.error(
      `${sourceStr} has ${found.length} skills; pass --skill <name> (repeatable), --all, or --list.`,
    )
    process.exit(1)
  }

  if (values.name && chosen.length > 1) {
    console.error(`--name only works when adding a single skill (matched ${chosen.length}).`)
    process.exit(1)
  }

  commit(
    chosen.map((c) =>
      buildSpec(c.subdir || undefined, chosen.length === 1 ? values.name : undefined),
    ),
  )
}

const skillList = (args: string[]) => {
  const { values } = parse(args)
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const cfg = loadConfig()
  const here = values.workspace ? resolveWorkspace(cfg, values.workspace) : currentWorkspace(cfg)
  const targets = here ? [here] : cfg.workspaces

  if (!targets.length) {
    console.log(`No workspaces yet. Add one with \`${name} add <path>\`.`)
    process.exit(0)
  }
  for (const ws of targets) {
    console.log(`\n${ws.name}  (${contractTilde(skillsDir(ws))})`)
    let any = false
    if (ws.selfSkill !== false) {
      const mark = skillLinked(ws, SELF_SKILL_NAME) ? green("✓ linked") : yellow("⚠ missing")
      console.log(`  ${SELF_SKILL_NAME.padEnd(18)}${orange("(bundled self-skill)")}  ${mark}`)
      any = true
    }
    for (const spec of ws.skills ?? []) {
      const s = normalizeSkill(spec)
      const mark = skillLinked(ws, s.name) ? green("✓ linked") : yellow("⚠ missing")
      console.log(`  ${s.name.padEnd(18)}${orange(sourceLabel(s))}  ${mark}`)
      any = true
    }
    if (!any) console.log("  (no skills)")
  }
  process.exit(0)
}

const skillRemove = (args: string[]) => {
  const { positionals, values } = parse(args)
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const target = positionals[0]
  if (!target) {
    console.error(`Specify a skill to remove, e.g. \`${name} skill rm <name>\`.`)
    process.exit(1)
  }
  const cfg = loadConfig()
  const ws = resolveWorkspace(cfg, values.workspace)

  // Removing the reserved self-skill opts this workspace out (persisted), rather
  // than deleting a declared source.
  if (target === SELF_SKILL_NAME) {
    if (ws.selfSkill === false) {
      console.log(`\nThe inscope self-skill is already disabled for "${ws.name}".`)
      process.exit(0)
    }
    persist({ ...ws, selfSkill: false })
    console.log(`\n✓ disabled the inscope self-skill for "${ws.name}"`)
    process.exit(0)
  }

  const specs = ws.skills ?? []
  const idx = specs.findIndex((sp) => normalizeSkill(sp).name === target)
  if (idx < 0) {
    console.error(`Workspace "${ws.name}" has no skill named "${target}".`)
    process.exit(1)
  }

  const remaining = specs.filter((_, i) => i !== idx)
  const next: Workspace = { ...ws, skills: remaining }
  if (!remaining.length) delete next.skills
  // Drop this skill's link explicitly (a local source is not cache-backed, so the
  // apply below would not prune it); persist then re-links anything still declared.
  unlinkSkillLink(ws, target)
  persist(next) // re-applies: reconciles the personal skills dir

  console.log(`\n✓ removed skill "${target}" from "${ws.name}"`)
  console.log(`  the cached copy is kept; other workspaces linking it are unaffected.`)
  process.exit(0)
}

const skillRename = (args: string[]) => {
  const { positionals, values } = parse(args)
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const [from, to] = positionals
  if (!from || !to) {
    console.error(`Usage: \`${name} skill rename <current-name> <new-name>\`.`)
    process.exit(1)
  }
  const cfg = loadConfig()
  const ws = resolveWorkspace(cfg, values.workspace)

  // The bundled self-skill's name is reserved; it is toggled with add/rm inscope,
  // never renamed, and no workspace skill may take or vacate that name via rename.
  if (from === SELF_SKILL_NAME || to === SELF_SKILL_NAME) {
    console.error(`"${SELF_SKILL_NAME}" is the bundled self-skill; use \`skill add/rm inscope\`.`)
    process.exit(1)
  }
  if (from === to) {
    console.log(`\nSkill "${from}" already has that name in "${ws.name}".`)
    process.exit(0)
  }

  const specs = ws.skills ?? []
  const idx = specs.findIndex((sp) => normalizeSkill(sp).name === from)
  if (idx < 0) {
    console.error(`Workspace "${ws.name}" has no skill named "${from}".`)
    process.exit(1)
  }
  const nameErr = skillNameError(to)
  if (nameErr) {
    console.error(`New skill name "${to}" is invalid: ${nameErr}`)
    process.exit(1)
  }
  if (specs.some((sp, i) => i !== idx && normalizeSkill(sp).name === to)) {
    console.error(`Workspace "${ws.name}" already has a skill named "${to}".`)
    process.exit(1)
  }

  // A skill's name lives only in the object form (renameSkillSpec expands a string
  // shorthand and preserves source/subdir/ref).
  const nextSkills = specs.map((sp, i) => (i === idx ? renameSkillSpec(sp, to) : sp))

  // Drop the old-name link explicitly (persist re-links under the new name and
  // prunes owned links no longer declared).
  unlinkSkillLink(ws, from)
  persist({ ...ws, skills: nextSkills })

  console.log(`\n✓ renamed skill "${from}" to "${to}" in "${ws.name}"`)
  console.log(`Relaunch \`claude\` from ${ws.path} to pick up the new /command name.`)
  process.exit(0)
}

const skillUpdate = (args: string[]) => {
  const { values } = parse(args)
  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }
  const cfg = loadConfig()
  const targets = values.workspace ? [resolveWorkspace(cfg, values.workspace)] : cfg.workspaces
  const withSkills = targets.filter((ws) => (ws.skills ?? []).length)
  if (!withSkills.length) {
    console.log("No skills to update.")
    process.exit(0)
  }
  // Floating git sources share one cache, so a single full-config pass pulls each
  // once and re-materializes every workspace's links (the shared ~/.claude/skills is
  // a union, so it must see the whole config, not just the -w target, to avoid
  // pruning another workspace's skills).
  applySkills(cfg, defaultRunner, { update: true })
  for (const ws of withSkills) console.log(`✓ updated skills for "${ws.name}"`)
  process.exit(0)
}

// Subcommands the `skills` CLI has that inscope has not built yet. Recognized so
// that muscle memory from `skills` gets a clear "planned" status instead of the
// generic unknown-command error.
const DEFERRED: Record<string, string> = {
  use: "run a skill once without installing it",
  find: "search for skills",
  init: "scaffold a new SKILL.md",
}

export const skill = async (args: string[]) => {
  const sub = args[0]
  if (!sub || sub === "-h" || sub === "--help") {
    console.log(helpMessage)
    process.exit(0)
  }
  requireConfigExists()
  const rest = args.slice(1)
  switch (sub) {
    case "add":
      return await skillAdd(rest)
    case "ls":
    case "list":
      return skillList(rest)
    case "rename":
    case "mv":
      return skillRename(rest)
    case "rm":
    case "remove":
      return skillRemove(rest)
    case "update":
      return skillUpdate(rest)
    default:
      if (sub in DEFERRED) {
        console.error(
          `\`${name} skill ${sub}\` is planned but not available yet (${DEFERRED[sub]}).`,
        )
        console.error(`Available now: add, list, rename, rm, update.`)
        process.exit(1)
      }
      console.error(`unknown skill command: ${sub}\n`)
      console.log(helpMessage)
      process.exit(1)
  }
}
