import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import {
  configExists,
  DEFAULT_SLACK_PACKAGE,
  hookValueError,
  labelFromPath,
  type NylasServer,
  loadConfig,
  pathConflict,
  type SlackPackage,
  type Workspace,
  workspaceNameError,
  workspacePathError,
} from "@/config"
import { contractTilde, resolveAbsolute, sameDir } from "@/env"
import { SERVER_TYPES } from "@/generators/mcp"
import { ghAccounts, gitGlobal, keychainHas, shQuotePath } from "@/secrets"
import {
  isInteractive,
  orange,
  promptConfirm,
  promptText,
  selectMany,
  selectOne,
  yellow,
} from "~/bin/commands/_prompt"
import {
  buildServers,
  DATADOG_SITE_CHOICES,
  datadogSiteOf,
  enabledServers,
  finalizeNylas,
  finalizeSlack,
  ghChoices,
  gitGlobalHint,
  NYLAS_REGION_CHOICES,
  nylasKeychainFor,
  persist,
  resolveDatadogSite,
  resolveNylasRegion,
  resolveSlackPackage,
  SLACK_PACKAGE_CHOICES,
  slackKeychainFor,
} from "~/bin/commands/_workspace"
import { name } from "~/package.json"

const helpMessage = `Map a workspace: a Claude login (shared or isolated), MCP servers, a GitHub account, a git commit email, and skills.
Runs interactively in a terminal; pass flags or -y to skip the prompts. Re-running
with the same label updates that workspace: the flags you pass change it and
everything else is kept. Each directory maps to one workspace.

Usage:
  $ ${name} add [path] [options]

Options:
  --gh <account>        gh account whose token this workspace uses
  --isolate             give this workspace its own Claude login: scaffold a local
                        <path>/.inscope config dir (gitignored) and launch claude
                        there when you run it from this subtree (--no-isolate
                        turns it off when updating a workspace)
  --email <email>       git commit email (omit to inherit your global identity)
  --git-name <name>     git commit author name (omit to inherit global)
  --label <name>        workspace name; defaults to the directory basename
  --servers <list>      comma-separated, any of: github, atlassian, canva,
                        clickup, datadog, hubspot, intercom, linear, monday,
                        notion, nylas, plane, posthog, sentry, slack, stripe,
                        vercel, webflow, xquik (default: github)
  --datadog-site <s>    Datadog site for the datadog server: us1 (default),
                        us3, us5, eu, ap1, ap2, uk1, or the site host
                        (e.g. datadoghq.eu)
  --nylas-keychain <s>  keychain service for the Nylas API key
                        (default: NYLAS_API_KEY_<LABEL> when nylas is on)
  --nylas-region <r>    Nylas region: us (default) or eu
  --seed-nylas          prompt for the Nylas API key and store it in the keychain
  --slack-keychain <s>  keychain service for the Slack token
                        (default: SLACK_MCP_XOXP_TOKEN_<LABEL> when slack is on)
  --slack-package <p>   Slack MCP server package: @nrjdalal/slack-mcp-server
                        (default, kept on latest) or slack-mcp-server (pinned)
  --slack-message       allow the Slack MCP server to post messages
                        (--no-slack-message turns it off)
  --seed-slack          prompt for the Slack token and store it in the keychain
  -y, --yes             accept defaults, skip all prompts (non-interactive)
  -h, --help            Display help message`

const serverChoices = (enabled: string[]) =>
  SERVER_TYPES.map((t) => ({ label: t, value: t, checked: enabled.includes(t) }))

// A git email/name prompt. With a stored value (re-running add on an existing
// workspace), enter keeps it and "-" inherits the global, like `edit`; otherwise
// blank inherits the global (or leaves it unset when there is none).
const promptGit = async (
  field: "email" | "name",
  stored: string | undefined,
): Promise<string | undefined> => {
  if (stored) {
    const ans = await promptText(
      `Git ${field} (enter keeps ${stored}, "-" to inherit global)`,
      stored,
    )
    return ans === "-" ? undefined : ans || undefined
  }
  return (
    (await promptText(`Git ${field} (${gitGlobalHint(gitGlobal(`user.${field}`))})`)) || undefined
  )
}

export const add = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      yes: { type: "boolean", short: "y" },
      gh: { type: "string" },
      isolate: { type: "boolean" },
      email: { type: "string" },
      "git-name": { type: "string" },
      label: { type: "string" },
      servers: { type: "string" },
      "datadog-site": { type: "string" },
      "nylas-keychain": { type: "string" },
      "nylas-region": { type: "string" },
      "seed-nylas": { type: "boolean" },
      "slack-keychain": { type: "string" },
      "slack-package": { type: "string" },
      "slack-message": { type: "boolean" },
      "seed-slack": { type: "boolean" },
    },
    // --no-isolate / --no-slack-message: the non-interactive way to turn one off when
    // re-running add on an existing workspace (an omitted flag keeps the stored value)
    allowNegative: true,
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const interactive = isInteractive() && !values.yes
  if (interactive) console.log()

  // --- path ---
  let target = positionals[0]
  if (!target) {
    if (interactive) target = await promptText("Workspace directory", contractTilde(process.cwd()))
    else throw new Error(helpMessage)
  }
  // Resolve a relative input (`.`, `./sub`, `myproj`) to a stable, cwd-independent
  // path up front, so the existence warning, conflict check, and success output
  // all reflect the same path that gets stored (upsertWorkspace resolves too).
  target = contractTilde(resolveAbsolute(target))
  const pathErr = workspacePathError(target)
  if (pathErr) {
    console.error(`\nInvalid workspace path "${target}": ${pathErr}`)
    process.exit(1)
  }
  // apply creates the .mcp.json (and its parent) on persist, so a typo'd path is
  // otherwise created silently. Warn but don't block: the dir may not exist yet.
  if (!fs.existsSync(resolveAbsolute(target))) {
    console.error(
      yellow(`Warning: ${contractTilde(target)} does not exist yet; it will be created.`) + "\n",
    )
  }

  // --- label ---
  let label = values.label || labelFromPath(target)
  if (interactive && !values.label) label = await promptText("Label", label)
  const labelErr = workspaceNameError(label)
  if (labelErr) {
    console.error(`\nInvalid label "${label}": ${labelErr}`)
    process.exit(1)
  }

  // A directory maps to exactly one workspace (one hook arm, one .mcp.json).
  // Adding a second label for a path another workspace already owns would create
  // a broken duplicate, so refuse and point at the existing one. Re-running with
  // the same label updates that workspace, so only a different name collides.
  const cfg = configExists() ? loadConfig() : null
  if (cfg) {
    const owner = pathConflict(cfg, target, label)
    if (owner) {
      console.error(
        `\n${contractTilde(target)} is already mapped to workspace "${owner.name}". Run \`${name} edit ${owner.name}\` to change it, or \`${name} rm ${owner.name}\` first.`,
      )
      process.exit(1)
    }
  }
  // Re-running with an existing label updates that workspace: start from what is
  // stored, so anything not passed as a flag (or changed at a prompt) is kept
  // instead of reset (isolation, servers and their settings, gh, git identity,
  // skills, selfSkill).
  const existing = cfg?.workspaces.find((w) => w.name === label)

  // --- gh account ---
  let gh = values.gh !== undefined ? values.gh || undefined : existing?.gh
  if (values.gh === undefined && interactive) {
    const { choices, initial } = ghChoices(ghAccounts(), existing ? (existing.gh ?? "") : undefined)
    gh = (await selectOne("\nGitHub account for this workspace", choices, initial)) || undefined
  }

  // --- git identity (blank inherits the global config, or leaves it unset when
  // there is no global to inherit) ---
  let email = values.email !== undefined ? values.email || undefined : existing?.git?.email
  let gitName =
    values["git-name"] !== undefined ? values["git-name"] || undefined : existing?.git?.name
  if (interactive) {
    if (values.email === undefined) email = await promptGit("email", existing?.git?.email)
    if (values["git-name"] === undefined) gitName = await promptGit("name", existing?.git?.name)
  }

  // --- MCP servers ---
  let serverList: string[]
  if (values.servers !== undefined) {
    serverList = values.servers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const known = new Set<string>(SERVER_TYPES)
    const unknown = serverList.filter((s) => !known.has(s))
    if (unknown.length) {
      console.error(yellow(`\nIgnoring unknown server(s): ${unknown.join(", ")}`))
    }
  } else {
    const current = existing ? enabledServers(existing.servers) : ["github"]
    serverList = interactive
      ? await selectMany("MCP servers (space toggles, enter confirms)", serverChoices(current))
      : current
  }

  // --- datadog site ---
  const flagSite = resolveDatadogSite(values["datadog-site"])
  if (flagSite === null) {
    console.error(
      `\nInvalid --datadog-site "${values["datadog-site"]}": use us1, us3, us5, eu, ap1, ap2, uk1, or a Datadog site host`,
    )
    process.exit(1)
  }
  let datadogSite = values["datadog-site"] || !existing ? flagSite : datadogSiteOf(existing.servers)
  if (values["datadog-site"] && !serverList.includes("datadog")) serverList.push("datadog")
  if (serverList.includes("datadog") && interactive && !values["datadog-site"]) {
    const siteInitial = Math.max(
      0,
      DATADOG_SITE_CHOICES.findIndex((c) => c.value === datadogSite),
    )
    datadogSite = await selectOne("\nDatadog site", DATADOG_SITE_CHOICES, siteInitial)
  }

  // --- nylas details ---
  const wantNylas =
    serverList.includes("nylas") ||
    !!values["nylas-keychain"] ||
    !!values["nylas-region"] ||
    !!values["seed-nylas"]
  if (wantNylas && !serverList.includes("nylas")) serverList.push("nylas")
  const flagRegion = resolveNylasRegion(values["nylas-region"])
  if (flagRegion === null) {
    console.error(`\nInvalid --nylas-region "${values["nylas-region"]}": use us or eu`)
    process.exit(1)
  }
  const curNylas = existing?.servers.nylas || null
  let nylasRegion = values["nylas-region"] || !curNylas ? flagRegion : (curNylas.region ?? "us")
  let nylasSvc = values["nylas-keychain"] || curNylas?.keychain || nylasKeychainFor(label)
  let seedNylas = !!values["seed-nylas"]
  if (wantNylas && interactive) {
    console.log(`\nNylas uses an API key from your Nylas dashboard.`)
    if (!values["nylas-region"])
      nylasRegion = await selectOne(
        "Nylas region",
        NYLAS_REGION_CHOICES,
        nylasRegion === "eu" ? 1 : 0,
      )
    if (!values["nylas-keychain"]) nylasSvc = await promptText("Nylas keychain service", nylasSvc)
    if (!values["seed-nylas"] && !keychainHas(nylasSvc))
      seedNylas = await promptConfirm("Store the Nylas API key now?", true)
  }
  const nylas: NylasServer | null = wantNylas ? { keychain: nylasSvc, region: nylasRegion } : null

  // --- slack details ---
  const wantSlack =
    serverList.includes("slack") ||
    !!values["slack-keychain"] ||
    !!values["slack-package"] ||
    !!values["seed-slack"]
  const curSlack = existing?.servers.slack || null
  let slackSvc = values["slack-keychain"] || curSlack?.keychain || slackKeychainFor(label)
  let slackMessage = values["slack-message"] ?? !!curSlack?.addMessageTool
  let seedSlack = !!values["seed-slack"]
  const resolvedPkg =
    values["slack-package"] === undefined && curSlack
      ? (curSlack.package ?? DEFAULT_SLACK_PACKAGE)
      : resolveSlackPackage(values["slack-package"])
  if (resolvedPkg === null) {
    console.error(
      `\nInvalid --slack-package "${values["slack-package"]}": use slack-mcp-server or @nrjdalal/slack-mcp-server`,
    )
    process.exit(1)
  }
  let slackPackage: SlackPackage = resolvedPkg
  if (wantSlack && interactive) {
    console.log(`\nSlack uses a user OAuth (xoxp) token.`)
    if (!values["slack-package"]) {
      const initial = Math.max(
        0,
        SLACK_PACKAGE_CHOICES.findIndex((c) => c.value === slackPackage),
      )
      slackPackage = await selectOne("Slack MCP server package", SLACK_PACKAGE_CHOICES, initial)
    }
    if (!values["slack-keychain"]) slackSvc = await promptText("Slack keychain service", slackSvc)
    if (values["slack-message"] === undefined)
      slackMessage = await promptConfirm(
        "Allow Slack to post messages?",
        curSlack ? slackMessage : true,
      )
    if (!values["seed-slack"] && !keychainHas(slackSvc))
      seedSlack = await promptConfirm("Store the Slack token now?", true)
  }

  // --- isolate: give this workspace its own Claude login in a local .inscope ---
  let isolate = values.isolate !== undefined ? values.isolate : Boolean(existing?.isolate)
  if (values.isolate === undefined && interactive) {
    isolate = await promptConfirm("\nDedicated Claude login for this workspace?", isolate)
  }

  // gh account and Slack keychain are interpolated into the chpwd hook; reject
  // values that would break out of the quoting (the --gh / --slack-keychain
  // flags and the keychain prompt are otherwise unchecked).
  const ghErr = gh ? hookValueError(gh) : null
  if (ghErr) {
    console.error(`\nInvalid gh account "${gh}": ${ghErr}`)
    process.exit(1)
  }
  if (nylas) {
    const svcErr = hookValueError(nylas.keychain)
    if (svcErr) {
      console.error(`\nInvalid Nylas keychain service "${nylas.keychain}": ${svcErr}`)
      process.exit(1)
    }
  }
  if (wantSlack) {
    const svcErr = hookValueError(slackSvc)
    if (svcErr) {
      console.error(`\nInvalid Slack keychain service "${slackSvc}": ${svcErr}`)
      process.exit(1)
    }
  }
  const ws: Workspace = {
    ...existing,
    isolate: isolate || undefined,
    name: label,
    path: contractTilde(target),
    gh,
    git: email || gitName ? { email, name: gitName } : undefined,
    servers: buildServers(
      serverList,
      wantSlack
        ? { keychain: slackSvc, addMessageTool: slackMessage, package: slackPackage }
        : null,
      { datadogSite, nylas },
      existing?.servers,
    ),
  }

  const firstRun = !configExists()
  // A move is a different directory (and so a different .inscope login), even when a
  // worktree's .mcp.json is shared with the old one.
  const moved = !!existing && !sameDir(existing.path, ws.path)
  // What is on disk decides the login messages: a directory moved with `mv` carries
  // its .inscope login along, and its old path no longer holds one.
  const loginAt = (p: string) => fs.existsSync(path.join(resolveAbsolute(p), ".inscope"))
  const hadLogin = loginAt(ws.path)
  persist(ws)
  console.log(`\n✓ ${existing ? "updated workspace" : "workspace"} "${label}" -> ${ws.path}`)
  if (moved) console.log(`✓ moved from ${existing.path}`)
  console.log(`✓ regenerated the hook, git includes, and ${ws.path}/.mcp.json`)
  if (ws.isolate && !hadLogin)
    console.log(
      `✓ scaffolded ${ws.path}/.inscope (gitignored) for this workspace's own Claude login`,
    )
  // The old login stays where it was: after turning isolation off, or after a move.
  if (existing?.isolate && (!ws.isolate || moved) && loginAt(existing.path))
    console.log(
      `\nNote: ${existing.path}/.inscope still holds a Claude login; it was left in place.\n` +
        `Delete it with: ${orange(`rm -rf ${shQuotePath(`${existing.path}/.inscope`)}`)}`,
    )
  await finalizeSlack(ws, seedSlack)
  await finalizeNylas(ws, seedNylas)
  if (firstRun)
    console.log(
      `\nFirst run: reload your shell to load the hook: source ~/.zshrc (or open a new terminal).`,
    )
  console.log(
    ws.isolate
      ? hadLogin
        ? `\nLaunch \`claude\` from ${ws.path}; this workspace keeps its own login in .inscope.`
        : `\nLaunch \`claude\` from ${ws.path} and sign in once; this workspace keeps its own login in .inscope.`
      : `\nLaunch \`claude\` from ${ws.path} (or relaunch) to pick up the new identity.`,
  )
  process.exit(0)
}
