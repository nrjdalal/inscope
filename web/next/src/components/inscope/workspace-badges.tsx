import { StatusBadge, type Tone } from "@/components/inscope/status-badge"
import { Spinner } from "@/components/ui/spinner"
import type { InscopeIdentity, InscopeWorkspace } from "@/lib/inscope"

const mcpBadge: Record<InscopeWorkspace["mcp"]["state"], { label: string; tone: Tone }> = {
  drifted: { label: "MCP drifted", tone: "warn" },
  "in-sync": { label: "MCP in sync", tone: "ok" },
  invalid: { label: "MCP invalid JSON", tone: "fail" },
  missing: { label: "MCP not written", tone: "warn" },
}

// The at-a-glance state of one workspace; the identity half arrives separately, since resolving it spawns claude and gh.
export function WorkspaceBadges({
  identity,
  identityPending,
  workspace,
}: {
  identity?: InscopeIdentity
  identityPending: boolean
  workspace: InscopeWorkspace
}) {
  const unlinked = workspace.skills.own.filter((s) => !s.linked).length
  const mcp = mcpBadge[workspace.mcp.state]
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge tone="muted">{workspace.isolated ? "Own login" : "Shared login"}</StatusBadge>
      {identityPending ? (
        <Spinner />
      ) : identity ? (
        <>
          {identity.claude.signedIn ? (
            <StatusBadge tone="ok">
              Signed in{identity.claude.email && ` as ${identity.claude.email}`}
            </StatusBadge>
          ) : (
            <StatusBadge tone="warn">Not signed in</StatusBadge>
          )}
          {identity.github ? (
            identity.github.token ? (
              <StatusBadge tone="ok">GitHub {identity.github.account}</StatusBadge>
            ) : (
              <StatusBadge tone="fail">GitHub {identity.github.account}: no token</StatusBadge>
            )
          ) : (
            <StatusBadge tone="muted">No GitHub account</StatusBadge>
          )}
        </>
      ) : (
        <StatusBadge tone="warn">Identity unavailable</StatusBadge>
      )}
      <StatusBadge tone={mcp.tone}>{mcp.label}</StatusBadge>
      {unlinked > 0 ? (
        <StatusBadge tone="warn">
          {unlinked} skill{unlinked === 1 ? "" : "s"} not linked
        </StatusBadge>
      ) : (
        <StatusBadge tone="ok">
          {workspace.skills.own.length} skill{workspace.skills.own.length === 1 ? "" : "s"} linked
        </StatusBadge>
      )}
    </div>
  )
}
