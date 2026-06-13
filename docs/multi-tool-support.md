# Future: multi-tool MCP support

Status: design sketch, not yet scheduled.

inscope today writes one `.mcp.json` per workspace, which is Claude Code's
project-scoped config convention. This note sketches how to also emit configs
for other MCP clients (Cursor, VS Code / Copilot) without touching the parts of
inscope that already work.

## The key insight: only file generation is tool-specific

inscope has three layers:

1. **Token resolution** — the zsh `chpwd` hook exports `GITHUB_TOKEN`,
   `GH_TOKEN`, and `SLACK_MCP_XOXP_TOKEN` based on `$PWD`
   (`src/generators/hook.ts`).
2. **Git identity** — `includeIf` rules scope the commit email per path
   (`src/generators/gitconfig.ts`).
3. **MCP config** — a `.mcp.json` per workspace (`src/generators/mcp.ts`).

Layers 1 and 2 are already tool-agnostic. Any client launched from that shell
inherits the env vars, and git does not care who reads it. So multi-tool
support is entirely a layer-3 change: emit the same logical server list into
each target client's file, in that client's dialect.

The `secrets.ts`, `hook.ts`, and `gitconfig.ts` modules do **not** change.

## Scope boundary: project-rooted clients only

inscope's whole premise is per-`$PWD` identity. That only works for clients
that read a config **relative to the project root**, because a single global
config file cannot switch identity on `cd`.

In scope (project-rooted):

| Client            | Config path (relative to workspace root) | Root key     | Env-var syntax |
| ----------------- | ---------------------------------------- | ------------ | -------------- |
| Claude Code       | `.mcp.json`                              | `mcpServers` | `${VAR}`       |
| Cursor            | `.cursor/mcp.json`                       | `mcpServers` | `${VAR}`       |
| VS Code / Copilot | `.vscode/mcp.json`                       | `servers`    | `${env:VAR}`   |

Out of scope (global-only config, no project override): Windsurf
(`~/.codeium/windsurf/mcp_config.json`), Codex (`~/.codex/config.toml`, and
TOML not JSON), Claude Desktop (`claude_desktop_config.json`). These cannot
express per-workspace identity, so they fall outside inscope's model.

> The two columns that bite are **root key** and **env-var syntax**. VS Code
> uses `servers` (not `mcpServers`) and `${env:GITHUB_TOKEN}` (not
> `${GITHUB_TOKEN}`), so the token placeholder inscope writes is **not**
> portable across clients. The renderer has to know each dialect.

## Proposed shape

### 1. A dialect table (new file: `src/generators/targets.ts`)

```ts
export type ToolId = "claude" | "cursor" | "vscode"

export type McpDialect = {
  id: ToolId
  relPath: string // joined onto the workspace root
  rootKey: "mcpServers" | "servers"
  envRef: (name: string) => string // how this client interpolates an env var
}

export const DIALECTS: Record<ToolId, McpDialect> = {
  claude: { id: "claude", relPath: ".mcp.json", rootKey: "mcpServers", envRef: (n) => `\${${n}}` },
  cursor: {
    id: "cursor",
    relPath: ".cursor/mcp.json",
    rootKey: "mcpServers",
    envRef: (n) => `\${${n}}`,
  },
  vscode: {
    id: "vscode",
    relPath: ".vscode/mcp.json",
    rootKey: "servers",
    envRef: (n) => `\${env:${n}}`,
  },
}
```

### 2. Parameterize the generator (`src/generators/mcp.ts`)

Every function that currently hardcodes the file name, the `mcpServers` key, or
the `${VAR}` placeholder gains a `dialect` argument. The
`${type}-${name}` unique-naming and the merge/prune-only-our-keys logic stay
exactly as they are; they are already tool-agnostic.

```ts
export const mcpFilePath = (ws: Workspace, d: McpDialect) =>
  path.join(resolveAbsolute(ws.path), d.relPath)

export const renderServers = (ws: Workspace, d: McpDialect): Record<string, unknown> => {
  // github header becomes:
  //   headers: { Authorization: `Bearer ${d.envRef("GITHUB_TOKEN")}` }
  // slack env becomes:
  //   env: { SLACK_MCP_XOXP_TOKEN: d.envRef("SLACK_MCP_XOXP_TOKEN") }
  // ...everything else (urls, stdio command/args) is identical across dialects
}

export const renderDoc = (ws: Workspace, d: McpDialect) => ({ [d.rootKey]: renderServers(ws, d) })

export const applyMcp = (ws: Workspace, d: McpDialect) => {
  /* read doc[d.rootKey], prune managedKeys, merge, write */
}
export const removeMcp = (ws: Workspace, d: McpDialect) => {
  /* prune managedKeys from doc[d.rootKey] */
}
export const readMcp = (ws: Workspace, d: McpDialect) => {
  /* ... */
}
```

`renderMcp` (the current `{ mcpServers }` wrapper) becomes `renderDoc(ws, d)`.

### 3. Config: opt in per workspace, default to Claude

Add an optional `tools` field to `Workspace` (`src/config.ts`). Absent means
`["claude"]`, so every existing config keeps producing exactly today's
`.mcp.json` and nothing else.

```ts
export type Workspace = {
  name: string
  path: string
  gh?: string
  git?: { email?: string; name?: string }
  servers: Servers
  tools?: ToolId[] // NEW — defaults to ["claude"]
}

export const workspaceTargets = (ws: Workspace): McpDialect[] =>
  (ws.tools ?? ["claude"]).map((id) => DIALECTS[id])
```

### 4. Callers loop over targets

- **`src/apply.ts` `applyAll`** — inner loop becomes
  `for (const d of workspaceTargets(ws)) { applyMcp(ws, d); mcp.push(mcpFilePath(ws, d)) }`.
- **`bin/commands/remove.ts`** — `for (const d of workspaceTargets(target)) removeMcp(target, d)`.
- **`src/doctor.ts`** — check each target's file exists and contains the
  managed keys; today the per-workspace `readMcp(ws)` call reads only
  `.mcp.json`.
- **`bin/commands/add.ts` / `edit.ts`** — add an optional multi-select prompt
  for tools, pre-checked to Claude. A `--tool <id>` (repeatable) flag for the
  non-interactive path.
- **`src/index.ts`** — re-export `DIALECTS` / `ToolId` alongside the existing
  MCP helpers.

## Tests and docs that move

- **Golden suite** (`test/golden.test.ts`) — add per-dialect snapshots
  (`renderDoc(ws, DIALECTS.cursor)`, `...vscode`). The Claude snapshots are
  unchanged, which is the backward-compat guarantee.
- **Unit tests** (`test/inscope.test.ts`) — the `applyMcp` merge / `removeMcp`
  prune tests should run once per dialect to prove we only touch our keys in
  each file shape (including VS Code's `servers` key).
- **README** — the "one `.mcp.json` per workspace" claim and the MCP section
  need a "supported clients" note.
- **`.gitignore` guidance** — we now write into `.cursor/` and `.vscode/`,
  which projects often commit. Worth a line in the docs about whether to ignore
  the generated files.

## Unknowns to verify before implementing

These clients move fast and the table above reflects an early-2026
understanding. Confirm against each client's current docs before coding:

- **Cursor**: does it interpolate `${VAR}` inside `headers` for remote/http
  servers, or only inside stdio `env`? If headers are not interpolated, the
  GitHub server needs a different approach for Cursor.
- **VS Code**: confirm the standalone `.vscode/mcp.json` still uses a top-level
  `servers` key (vs the older nested `mcp.servers` inside `settings.json`), and
  that `${env:VAR}` works in header values. Check whether `type` is required on
  each entry.
- **All three**: confirm the http vs stdio entry shapes still match what
  `renderServers` emits today (`type`, `url`, `headers`, `command`, `args`,
  `env`).

## Effort estimate

Small-to-medium and well isolated:

- New `targets.ts`: trivial.
- Thread `dialect` through `mcp.ts`: mechanical, the body logic is unchanged.
- Config field + `workspaceTargets` helper: small.
- Caller loops (apply, remove, doctor, add/edit): small.
- Tests + README: the bulk of the diff, but low-risk.

No changes to token resolution, the shell hook, secrets, or git identity. The
backward-compat contract is the existing Claude golden snapshots staying byte
for byte identical.
