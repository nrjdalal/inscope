"use client"

import { notFound, useParams } from "next/navigation"

import { CheckList } from "@/components/inscope/check-list"
import { DriftDiff } from "@/components/inscope/drift-diff"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { SkillList } from "@/components/inscope/skill-list"
import { WorkspaceBadges } from "@/components/inscope/workspace-badges"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { useInscopeWorkspace } from "@/lib/inscope"

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 font-mono break-words">{children}</dd>
  </div>
)

const Section = ({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) => (
  <section aria-labelledby={id} className="space-y-3">
    <h2 id={id} className="font-semibold">
      {title}
    </h2>
    {children}
  </section>
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
      <QueryState query={detail}>
        {({ checks, drifts, identity, workspace }) => (
          <div className="space-y-8">
            <PageHeader
              className="mb-0"
              title={workspace.name}
              description={<span className="font-mono">{workspace.path}</span>}
              actions={<RefreshButton />}
            />
            <WorkspaceBadges workspace={workspace} identity={identity} identityPending={false} />
            <Section id="identity" title="Identity">
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
            </Section>
            <Section id="mcp" title="MCP servers">
              <dl className="space-y-2">
                <Row label="File">{workspace.mcp.path}</Row>
                <Row label="Servers">
                  {workspace.servers.length ? workspace.servers.join(", ") : "none"}
                </Row>
                {workspace.mcp.error && <Row label="Problem">{workspace.mcp.error}</Row>}
              </dl>
            </Section>
            <Section id="skills" title="Skills">
              <p className="text-muted-foreground font-mono text-sm">{workspace.skills.dir}</p>
              <SkillList skills={workspace.skills} />
            </Section>
            <Section id="checks" title="Checks">
              {checks.length ? (
                <CheckList checks={checks} />
              ) : (
                <p className="text-muted-foreground text-sm">No checks for this workspace.</p>
              )}
            </Section>
            <Section id="changes" title="Pending changes">
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
                <p className="text-muted-foreground text-sm">In sync with the config.</p>
              )}
            </Section>
          </div>
        )}
      </QueryState>
    </PageShell>
  )
}
