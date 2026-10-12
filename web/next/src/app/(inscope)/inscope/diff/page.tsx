"use client"

import { DriftSection } from "@/components/inscope/drift-diff"
import { InSync } from "@/components/inscope/in-sync"
import { PageSection } from "@/components/inscope/page-section"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { useInscopeDiff } from "@/lib/inscope"

export default function Page() {
  const diff = useInscopeDiff()

  return (
    <PageShell size="lg">
      <PageHeader
        title="Pending changes"
        description="What inscope apply would change on disk, with credential values redacted."
        actions={<RefreshButton />}
      />
      <QueryState query={diff}>
        {(data) =>
          data.drifts.length === 0 && data.adoptable.length === 0 ? (
            <InSync />
          ) : (
            <div className="space-y-8">
              {data.adoptable.length > 0 && (
                <PageSection id="adoptable" title="Hand edits apply would undo">
                  <p className="text-muted-foreground text-sm">
                    <code>inscope diff --adopt</code> pulls these back into the config instead.
                  </p>
                  <ul className="list-inside list-disc font-mono text-sm">
                    {data.adoptable.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                </PageSection>
              )}
              {data.drifts.map((drift) => (
                <DriftSection key={drift.label} drift={drift} />
              ))}
            </div>
          )
        }
      </QueryState>
    </PageShell>
  )
}
