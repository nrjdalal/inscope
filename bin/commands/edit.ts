import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import { poolAfterChange } from "@/accounts"
import {
  DEFAULT_SLACK_PACKAGE,
  findWorkspace,
  hookValueError,
  type NylasServer,
  type SlackPackage,
  type Workspace,
} from "@/config"
import { contractTilde, resolveAbsolute } from "@/env"
import { DEFAULT_POOL } from "@/proxy"
import { ghAccounts, keychainHas, shQuotePath } from "@/secrets"
import { requireConfig } from "~/bin/commands/_config"
import {
  isInteractive,
  orange,
  promptConfirm,
  promptText,
  selectMany,
  selectOne,
} from "~/bin/commands/_prompt"
import {
  buildServers,
  DATADOG_SITE_CHOICES,
  datadogSiteOf,
  enabledServers,
  finalizeNylas,
  finalizeSlack,
  ghChoices,
  NYLAS_REGION_CHOICES,
  nylasKeychainFor,
  persist,
  SERVER_LABELS,
  SLACK_PACKAGE_CHOICES,
  slackKeychainFor,
} from "~/bin/commands/_workspace"
import { name } from "~/package.json"

const helpMessage = `Edit a configured workspace interactively, then re-apply.
Pick a workspace (or pass its path/label), step through the prompts pre-filled
with its current values, and inscope regenerates everything on save.

Usage:
  $ ${name} edit [path|label]

Options:
  -h, --help  Display help message`

export const edit = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
    args,
  })

  if (values.help) {
    console.log(helpMessage)
    process.exit(0)
  }

  const cfg = requireConfig()
  if (!cfg.workspaces.length) {
    console.error(`No workspaces yet. Add one with \`${name} add <path>\`.`)
    process.exit(1)
  }

  // --- choose the workspace ---
  const key = positionals[0]
  const pick = async (): Promise<Workspace> => {
    if (key) {
      const found = findWorkspace(cfg, key)
      if (!found) {
        console.error(`No workspace matching "${key}".`)
        process.exit(1)
      }
      return found
    }
    if (cfg.workspaces.length === 1) return cfg.workspaces[0]
    if (isInteractive()) {
      return selectOne(
        "Edit which workspace?",
        cfg.workspaces.map((w) => ({
          label: `${w.name}  (${w.path})`,
          value: w,
        })),
      )
    }
    console.error(`Specify a workspace, e.g. \`${name} edit <label>\`.`)
    process.exit(1)
  }
  const ws = await pick()

  console.log(`\nEditing "${ws.name}" (${ws.path})\n`)

  // --- gh account, pre-selected to the current one ---
  // gh is not re-validated here (unlike add.ts): it can only be a real account
  // from ghAccounts(), the stored one (validated when the config loaded), or empty,
  // never free text, so it cannot carry hook metacharacters. validateConfig is the
  // backstop. If a --gh flag is ever added to edit, validate it with hookValueError
  // the way add.ts does.
  const { choices: ghOptions, initial: ghInitial } = ghChoices(ghAccounts(), ws.gh ?? "")
  const gh = (await selectOne("GitHub account", ghOptions, ghInitial)) || undefined

  // --- git identity: enter keeps current, "-" inherits the global config ---
  const curEmail = ws.git?.email
  const emailAns = await promptText(
    curEmail
      ? `Git email (enter keeps ${curEmail}, "-" to inherit global)`
      : "Git email (enter to inherit global)",
    curEmail ?? "",
  )
  const email = emailAns === "-" ? undefined : emailAns || undefined

  const curName = ws.git?.name
  const nameAns = await promptText(
    curName
      ? `Git name (enter keeps ${curName}, "-" to inherit global)`
      : "Git name (enter to inherit global)",
    curName ?? "",
  )
  const gitName = nameAns === "-" ? undefined : nameAns || undefined

  // --- MCP servers, pre-checked to the current set ---
  const current = enabledServers(ws.servers)
  const serverList = await selectMany(
    "MCP servers (space toggles, enter confirms)",
    SERVER_LABELS.map((l) => ({
      label: l,
      value: l,
      checked: current.includes(l),
    })),
  )

  // --- datadog site, pre-filled from the current config ---
  let datadogSite = datadogSiteOf(ws.servers)
  if (serverList.includes("datadog")) {
    const siteInitial = Math.max(
      0,
      DATADOG_SITE_CHOICES.findIndex((c) => c.value === datadogSite),
    )
    datadogSite = await selectOne("\nDatadog site", DATADOG_SITE_CHOICES, siteInitial)
  }

  // --- nylas details, pre-filled from the current config ---
  const curNylas = ws.servers.nylas || null
  let nylas: NylasServer | null = null
  let seedNylas = false
  if (serverList.includes("nylas")) {
    console.log(`\nNylas uses an API key from your Nylas dashboard.`)
    const region = await selectOne(
      "Nylas region",
      NYLAS_REGION_CHOICES,
      curNylas?.region === "eu" ? 1 : 0,
    )
    const keychain = await promptText(
      "Nylas keychain service",
      curNylas?.keychain ?? nylasKeychainFor(ws.name),
    )
    const svcErr = hookValueError(keychain)
    if (svcErr) {
      console.error(`\nInvalid Nylas keychain service "${keychain}": ${svcErr}`)
      process.exit(1)
    }
    nylas = { keychain, region }
    if (!keychainHas(keychain))
      seedNylas = await promptConfirm("Store the Nylas API key now?", true)
  }

  // --- slack details, pre-filled from the current config ---
  const wantSlack = serverList.includes("slack")
  let slackSvc = ws.servers.slack ? ws.servers.slack.keychain : slackKeychainFor(ws.name)
  let slackMessage = ws.servers.slack ? !!ws.servers.slack.addMessageTool : false
  let slackPackage: SlackPackage = ws.servers.slack
    ? (ws.servers.slack.package ?? DEFAULT_SLACK_PACKAGE)
    : DEFAULT_SLACK_PACKAGE
  let seedSlack = false
  if (wantSlack) {
    console.log(`\nSlack uses a user OAuth (xoxp) token.`)
    const pkgInitial = Math.max(
      0,
      SLACK_PACKAGE_CHOICES.findIndex((c) => c.value === slackPackage),
    )
    slackPackage = await selectOne("Slack MCP server package", SLACK_PACKAGE_CHOICES, pkgInitial)
    slackSvc = await promptText("Slack keychain service", slackSvc)
    slackMessage = await promptConfirm("Allow Slack to post messages?", slackMessage)
    if (!keychainHas(slackSvc)) seedSlack = await promptConfirm("Store the Slack token now?", true)
  }

  // The keychain service is typed at the prompt and interpolated into the hook;
  // reject values that would break out of the quoting.
  if (wantSlack) {
    const svcErr = hookValueError(slackSvc)
    if (svcErr) {
      console.error(`\nInvalid Slack keychain service "${slackSvc}": ${svcErr}`)
      process.exit(1)
    }
  }
  // --- Claude config: the shared base, or its own .inscope ---
  const isolate = await promptConfirm(
    "Separate Claude config for this workspace (its own history, settings, and skills)?",
    Boolean(ws.isolate),
  )
  // Once named pools exist, an isolated workspace picks the pool its requests use.
  let wantPool: string | undefined
  if (isolate && cfg.pools?.length) {
    const names = [DEFAULT_POOL, ...cfg.pools.map((p) => p.name)]
    wantPool = await selectOne(
      "Pool of Claude accounts for this workspace",
      names.map((n) => ({ label: n, value: n })),
      Math.max(0, names.indexOf(ws.pool ?? DEFAULT_POOL)),
    )
  }
  const poolChange = poolAfterChange(cfg, ws, isolate, wantPool)

  // Start from the stored workspace so fields this prompt flow does not manage
  // (skills, selfSkill) survive the edit; upsert replaces the whole entry.
  const next: Workspace = {
    ...ws,
    isolate: isolate || undefined,
    pool: poolChange.pool,
    name: ws.name,
    // Resolve here too so the success output below prints the same path that
    // persist stores; also normalizes a legacy config whose path was saved
    // cwd-relative (best-effort: resolves against the current cwd).
    path: contractTilde(resolveAbsolute(ws.path)),
    gh,
    git: email || gitName ? { email, name: gitName } : undefined,
    servers: buildServers(
      serverList,
      wantSlack
        ? { keychain: slackSvc, addMessageTool: slackMessage, package: slackPackage }
        : null,
      { datadogSite, nylas },
      ws.servers,
    ),
  }

  persist(next)
  console.log(`\n✓ updated "${next.name}" -> ${next.path}`)
  if (next.isolate && !ws.isolate)
    console.log(
      `✓ scaffolded ${next.path}/.inscope (gitignored) for this workspace's own Claude config`,
    )
  else if (
    ws.isolate &&
    !next.isolate &&
    fs.existsSync(path.join(resolveAbsolute(next.path), ".inscope"))
  )
    console.log(
      `\nNote: ${next.path}/.inscope still holds this workspace's Claude config (its history, and any login); it was left in place.\n` +
        `Delete it with: ${orange(`rm -rf ${shQuotePath(`${next.path}/.inscope`)}`)}`,
    )
  if (poolChange.note) console.log(poolChange.note)
  await finalizeSlack(next, seedSlack)
  await finalizeNylas(next, seedNylas)
  console.log(`\nRelaunch \`claude\` from ${next.path} to pick up the changes.`)
  process.exit(0)
}
