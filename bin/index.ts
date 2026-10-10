#!/usr/bin/env node
import { add } from "~/bin/commands/add"
import { apply } from "~/bin/commands/apply"
import { diff } from "~/bin/commands/diff"
import { doctor } from "~/bin/commands/doctor"
import { edit } from "~/bin/commands/edit"
import { list } from "~/bin/commands/list"
import { login } from "~/bin/commands/login"
import { logout } from "~/bin/commands/logout"
import { proxy } from "~/bin/commands/proxy"
import { remove } from "~/bin/commands/remove"
import { skill } from "~/bin/commands/skill"
import { status } from "~/bin/commands/status"
import { usage } from "~/bin/commands/usage"
import { author, name, version } from "~/package.json"

const helpMessage = `Version:
  ${name}@${version}

Per-workspace identity for Claude Code: each directory auto-resolves its own Claude
config, MCP servers, GitHub account, and skills, and every Claude account you sign in
is pooled behind one local proxy, so a conversation carries on past an account's limit.

Usage:
  $ ${name} <command> [options]

Commands:
  add [path]     Map a workspace (Claude config, MCP servers, GitHub account, git email, skills); sets up inscope on first run
  status         Show the identity resolved for the current directory (alias: whoami)
  list           List configured workspaces (alias: ls)
  edit [path]    Edit a workspace interactively, then re-apply
  rm [path]      Remove a workspace mapping (alias: remove)
  skill          Manage a workspace's Claude skills (add, list, rename, rm, update)
  login          Sign a Claude account in (into the local proxy every login goes through)
  logout <email> Remove a Claude account from the proxy
  usage          Show each account's plan, 5-hour and weekly limits, and when they reset
  proxy          The proxy's low-level controls (status, start, stop, setup, uninstall)
  doctor         Verify tokens, identities, the hook, and skill links resolve correctly
  diff           Preview what apply would change; --adopt pulls on-disk extras back
  apply          Regenerate the hook, git includes, .mcp.json, and skill links (alias: sync)

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
        return await edit(rest)
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
      case "login":
        return await login(rest)
      case "logout":
        return logout(rest)
      case "usage":
        return await usage(rest)
      case "proxy":
        return await proxy(rest)
      case "diff":
        return diff(rest)
      case "apply":
      case "sync":
        return apply(rest)
      case "doctor":
        return doctor(rest)
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
