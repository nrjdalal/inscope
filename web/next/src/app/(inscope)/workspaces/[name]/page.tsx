"use client"

import { notFound, useParams } from "next/navigation"

import { CheckList } from "@/components/inscope/check-list"
import { DriftSection } from "@/components/inscope/drift-section"
import { InSync } from "@/components/inscope/in-sync"
import { InscopeSection } from "@/components/inscope/inscope-section"
import { McpServerList } from "@/components/inscope/mcp-server-list"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { SkillList } from "@/components/inscope/skill-list"
import { WorkspaceBadges } from "@/components/inscope/workspace-badges"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useInscopeWorkspace } from "@/lib/inscope"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono wrap-anywhere">{children}</dd>
    </div>
  )
}

export default function Page() {
  const { name } = useParams<{ name: string }>()
  // a workspace name is letters, digits, dot, dash, and underscore, none of which a URL encodes, so a name that needs encoding (raw or decoded) names no workspace, and the API, which refuses an encoded path, is never asked
  const urlSafe = encodeURIComponent(name) === name
  const detail = useInscopeWorkspace(name, { enabled: urlSafe })
  if (
    !urlSafe ||
    (detail.isError &&
      (detail.error.code === "INSCOPE_WORKSPACE_NOT_FOUND" ||
        detail.error.code === "VALIDATION_ERROR"))
  )
    notFound()

  return (
    <PageShell size="lg">
      <PageHeader
        title={name}
        description={
          detail.data && (
            <span className="font-mono wrap-anywhere">{detail.data.workspace.path}</span>
          )
        }
        actions={<RefreshButton />}
      />
      <QueryState query={detail}>
        {({ checks, drifts, identity, workspace }) => (
          <div className="space-y-8">
            <WorkspaceBadges workspace={workspace} identity={identity} identityPending={false} />
            <InscopeSection id="identity" title="Identity">
              <dl className="space-y-2">
                <Row label="Claude login">
                  {identity.claude.isolated ? "own login" : "shared login"} in{" "}
                  {identity.claude.configDir}
                </Row>
                <Row label="Signed in">
                  {identity.claude.signedIn
                    ? [identity.claude.email, identity.claude.subscription, identity.claude.org]
                        .filter(Boolean)
                        .join(", ") || "yes"
                    : "no; launch claude here and log in"}
                </Row>
                <Row label="GitHub">
                  {identity.github
                    ? `${identity.github.account}, ${identity.github.token ? "token available" : "no token"}`
                    : "none"}
                </Row>
                <Row label="Git email">
                  {identity.git.email ?? "unset"} ({identity.git.source})
                </Row>
              </dl>
            </InscopeSection>
            <InscopeSection id="mcp" title="MCP servers" description={workspace.mcp.path}>
              {workspace.mcp.error && (
                <p className="text-destructive text-sm">{workspace.mcp.error}</p>
              )}
              <McpServerList servers={workspace.mcp.servers} />
            </InscopeSection>
            <InscopeSection id="skills" title="Skills" description={workspace.skills.dir}>
              <SkillList skills={workspace.skills} />
            </InscopeSection>
            <InscopeSection id="checks" title="Checks">
              {checks.length ? (
                <CheckList checks={checks} />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No checks</EmptyTitle>
                    <EmptyDescription>
                      Doctor runs no check that belongs to this workspace.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </InscopeSection>
            <InscopeSection id="changes" title="Pending changes">
              {drifts.length ? (
                drifts.map((drift) => <DriftSection key={drift.label} drift={drift} level={3} />)
              ) : (
                <InSync workspace={workspace.name} />
              )}
            </InscopeSection>
          </div>
        )}
      </QueryState>
    </PageShell>
  )
}
