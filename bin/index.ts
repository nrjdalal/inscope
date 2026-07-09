#!/usr/bin/env node
import { account } from "~/bin/commands/account"
import { add } from "~/bin/commands/add"
import { apply } from "~/bin/commands/apply"
import { diff } from "~/bin/commands/diff"
import { doctor } from "~/bin/commands/doctor"
import { edit } from "~/bin/commands/edit"
import { list } from "~/bin/commands/list"
import { mcp } from "~/bin/commands/mcp"
import { remove } from "~/bin/commands/remove"
import { skill } from "~/bin/commands/skill"
import { status } from "~/bin/commands/status"
import { switchAccount, use } from "~/bin/commands/switch"
import { usage } from "~/bin/commands/usage"
import { author, name, version } from "~/package.json"

const helpMessage = `Version:
  ${name}@${version}

Per-workspace identity for Claude Code: scope MCP servers, GitHub auth, and git
commit identity to the directory you are in, so concurrent sessions never clash.

Usage:
  $ ${name} <command> [options]

Commands:
  add [path]     Map a workspace (Claude login, MCP servers, GitHub account, git email, skills); sets up inscope on first run
  status         Show the identity resolved for the current directory (alias: whoami)
  list           List configured workspaces (alias: ls)
  edit [path]    Edit a workspace interactively, then re-apply
  rm [path]      Remove a workspace mapping (alias: remove)
  skill          Manage a workspace's Claude skills (add, list, rename, rm, update)
  doctor         Verify tokens, identities, the hook, and skill links resolve correctly
  diff           Preview what apply would change; --adopt pulls on-disk extras back
  apply          Regenerate the hook, git includes, .mcp.json, and skill links (alias: sync)
  account        Manage the pool of Claude logins a workspace can switch between (add, list)
  switch [acct]  Switch a workspace to another pooled account (alias: use); no arg picks the next signed-in
  usage          Show live 5h/7d Claude usage per pooled account (from the OAuth usage endpoint)
  mcp            Run inscope as an MCP server (stdio), so Claude can drive it

Options:
  -v, --version  Display version
  -h, --help     Display help

Author:
  ${author.name} <${author.email}> (${author.url})`

const main = async () => {
  try {
    const args = process.argv.slice(2)
    const cmd = args[0]
    const rest = args.slice(1)

    switch (cmd) {
      case "add":
        return await add(rest)
      case "edit":
        return edit(rest)
      case "rm":
      case "remove":
        return await remove(rest)
      case "ls":
      case "list":
        return list(rest)
      case "status":
      case "whoami":
        return status(rest)
      case "skill":
        return await skill(rest)
      case "diff":
        return diff(rest)
      case "apply":
      case "sync":
        return apply(rest)
      case "doctor":
        return doctor(rest)
      case "account":
        return account(rest)
      case "use":
        return use(rest)
      case "switch":
        return switchAccount(rest)
      case "usage":
        return await usage(rest)
      case "mcp":
        return mcp()
    }

    if (cmd === "-v" || cmd === "--version") {
      console.log(`${name}@${version}`)
      process.exit(0)
    }

    if (!cmd || cmd === "-h" || cmd === "--help") {
      console.log(helpMessage)
      process.exit(0)
    }

    console.error(`unknown command: ${args.join(" ")}\n`)
    console.error(helpMessage)
    process.exit(1)
  } catch (err: any) {
    console.error(err.message)
    process.exit(1)
  }
}

main()
