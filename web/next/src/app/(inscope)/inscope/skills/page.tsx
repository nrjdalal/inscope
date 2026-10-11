"use client"

import { NoWorkspaces } from "@/components/inscope/no-workspaces"
import { PageSection } from "@/components/inscope/page-section"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { SkillList } from "@/components/inscope/skill-list"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
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
            <NoWorkspaces configExists={data.config.exists} />
          ) : (
            <div className="space-y-8">
              {data.workspaces.map((workspace) => (
                <PageSection
                  key={workspace.name}
                  id={`skills-${workspace.name}`}
                  title={workspace.name}
                  description={workspace.skills.dir}
                >
                  <SkillList skills={workspace.skills} />
                </PageSection>
              ))}
            </div>
          )
        }
      </QueryState>
    </PageShell>
  )
}
