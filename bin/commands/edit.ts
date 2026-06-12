import { parseArgs } from "node:util"
import {
  configExists,
  findWorkspace,
  hookValueError,
  loadConfig,
  type Workspace,
} from "@/config"
import { ghAccounts, keychainHas } from "@/secrets"
import {
  isInteractive,
  promptConfirm,
  promptText,
  selectMany,
  selectOne,
} from "~/bin/commands/_prompt"
import {
  buildServers,
  enabledServers,
  finalizeSlack,
  persist,
  SERVER_LABELS,
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

  if (!configExists()) {
    console.error(`No config found. Run \`${name} init\` first.`)
    process.exit(1)
  }

  const cfg = loadConfig()
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
  // from selectOne(ghAccounts()) or empty, never free text, so it cannot carry
  // hook metacharacters. validateConfig is the backstop. If a --gh flag is ever
  // added to edit, validate it with hookValueError the way add.ts does.
  const ghChoices = [
    ...ghAccounts().map((a) => ({ label: a, value: a })),
    { label: "(none)", value: "" },
  ]
  const ghInitial = Math.max(
    0,
    ghChoices.findIndex((c) => c.value === (ws.gh ?? "")),
  )
  const gh =
    (await selectOne("GitHub account", ghChoices, ghInitial)) || undefined

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

  // --- slack details, pre-filled from the current config ---
  const wantSlack = serverList.includes("slack")
  let slackSvc = ws.servers.slack
    ? ws.servers.slack.keychain
    : slackKeychainFor(ws.name)
  let slackMessage = ws.servers.slack
    ? !!ws.servers.slack.addMessageTool
    : false
  let seedSlack = false
  if (wantSlack) {
    console.log(`\nSlack uses a user OAuth (xoxp) token.`)
    slackSvc = await promptText("Slack keychain service", slackSvc)
    slackMessage = await promptConfirm(
      "Allow Slack to post messages?",
      slackMessage,
    )
    if (!keychainHas(slackSvc))
      seedSlack = await promptConfirm("Store the Slack token now?", true)
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

  const next: Workspace = {
    name: ws.name,
    path: ws.path,
    gh,
    git: email || gitName ? { email, name: gitName } : undefined,
    servers: buildServers(
      serverList,
      wantSlack ? { keychain: slackSvc, addMessageTool: slackMessage } : null,
    ),
  }

  persist(next)
  console.log(`\n✓ updated "${next.name}" -> ${next.path}`)
  await finalizeSlack(next, seedSlack)
  console.log(`\nRelaunch \`claude\` from ${next.path} to pick up the changes.`)
  process.exit(0)
}
