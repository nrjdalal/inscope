"use client"

import { notFound, useParams } from "next/navigation"

import { CheckList } from "@/components/inscope/check-list"
import { DriftDiff } from "@/components/inscope/drift-diff"
import { McpServerList } from "@/components/inscope/mcp-server-list"
import { PageSection } from "@/components/inscope/page-section"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { SkillList } from "@/components/inscope/skill-list"
import { WorkspaceBadges } from "@/components/inscope/workspace-badges"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useInscopeWorkspace } from "@/lib/inscope"

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 font-mono break-words">{children}</dd>
  </div>
)

export default function Page() {
  const { name } = useParams<{ name: string }>()
  const detail = useInscopeWorkspace(name)
  if (
    detail.isError &&
    (detail.error.code === "NOT_FOUND" || detail.error.code === "VALIDATION_ERROR")
  )
    notFound()

  return (
    <PageShell size="lg">
      <PageHeader
        title={name}
        description={detail.data && <span className="font-mono">{detail.data.workspace.path}</span>}
        actions={<RefreshButton />}
      />
      <QueryState query={detail}>
        {({ checks, drifts, identity, workspace }) => (
          <div className="space-y-8">
            <WorkspaceBadges workspace={workspace} identity={identity} identityPending={false} />
            <PageSection id="identity" title="Identity">
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
            </PageSection>
            <PageSection id="mcp" title="MCP servers" description={workspace.mcp.path}>
              {workspace.mcp.error && (
                <p className="text-destructive text-sm">{workspace.mcp.error}</p>
              )}
              <McpServerList servers={workspace.mcp.servers} />
            </PageSection>
            <PageSection id="skills" title="Skills" description={workspace.skills.dir}>
              <SkillList skills={workspace.skills} />
            </PageSection>
            <PageSection id="checks" title="Checks">
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
            </PageSection>
            <PageSection id="changes" title="Pending changes">
              {drifts.length ? (
                drifts.map((drift) => (
                  <div key={drift.label} className="space-y-2">
                    <p className="font-mono text-sm">
                      {drift.label} <span className="text-muted-foreground">{drift.path}</span>
                    </p>
                    <DriftDiff drift={drift} />
                  </div>
                ))
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>In sync</EmptyTitle>
                    <EmptyDescription>
                      Every file inscope manages for this workspace matches the config.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </PageSection>
          </div>
        )}
      </QueryState>
    </PageShell>
  )
}
