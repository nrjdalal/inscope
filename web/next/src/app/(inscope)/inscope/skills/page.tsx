"use client"

import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { SkillList } from "@/components/inscope/skill-list"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useInscopeOverview } from "@/lib/inscope"

export default function Page() {
  const overview = useInscopeOverview()

  return (
    <PageShell size="lg">
      <PageHeader
        title="Skills"
        description="Every skill in each workspace's skills folder, as inscope skill list shows them."
        actions={<RefreshButton />}
      />
      <QueryState query={overview}>
        {(data) =>
          data.workspaces.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No workspaces yet</EmptyTitle>
                <EmptyDescription>
                  Map a directory with <code>inscope add &lt;path&gt;</code>, then refresh.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-8">
              {data.workspaces.map((workspace) => (
                <section
                  key={workspace.name}
                  aria-labelledby={`skills-${workspace.name}`}
                  className="space-y-3"
                >
                  <div className="space-y-1">
                    <h2 id={`skills-${workspace.name}`} className="font-semibold">
                      {workspace.name}
                    </h2>
                    <p className="text-muted-foreground font-mono text-sm">
                      {workspace.skills.dir}
                    </p>
                  </div>
                  <SkillList skills={workspace.skills} />
                </section>
              ))}
            </div>
          )
        }
      </QueryState>
    </PageShell>
  )
}
