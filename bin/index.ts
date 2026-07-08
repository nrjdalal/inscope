#!/usr/bin/env node
import { add } from "~/bin/commands/add"
import { apply } from "~/bin/commands/apply"
import { diff } from "~/bin/commands/diff"
import { doctor } from "~/bin/commands/doctor"
import { edit } from "~/bin/commands/edit"
import { init } from "~/bin/commands/init"
import { list } from "~/bin/commands/list"
import { remove } from "~/bin/commands/remove"
import { skill } from "~/bin/commands/skill"
import { author, name, version } from "~/package.json"

const helpMessage = `Version:
  ${name}@${version}

Per-workspace identity for Claude Code: scope MCP servers, GitHub auth, and git
commit identity to the directory you are in, so concurrent sessions never clash.

Usage:
  $ ${name} <command> [options]

Commands:
  init           Create the config, generate the hook, source it from ~/.zshrc
  add [path]     Map a directory to a GitHub account, git email, and MCP servers
  edit [path]    Edit a workspace interactively, then re-apply
  rm [path]      Remove a workspace mapping (alias: remove)
  list           List configured workspaces (alias: ls)
  skill          Manage a workspace's Claude skills (add, list, rm, update)
  diff           Preview what apply would change; --adopt pulls on-disk extras back
  apply          Regenerate the hook, git includes, .mcp.json, and skill links (alias: sync)
  doctor         Verify tokens, identities, and the hook resolve correctly

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
      case "init":
        return init(rest)
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
      case "skill":
        return await skill(rest)
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
