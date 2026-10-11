"use client"

import { DriftDiff } from "@/components/inscope/drift-diff"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
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
            <Empty>
              <EmptyHeader>
                <EmptyTitle>In sync</EmptyTitle>
                <EmptyDescription>Every file inscope manages matches the config.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-8">
              {data.adoptable.length > 0 && (
                <section aria-labelledby="adoptable" className="space-y-2">
                  <h2 id="adoptable" className="font-semibold">
                    Hand edits apply would undo
                  </h2>
                  <p className="text-muted-foreground text-sm">
                    <code>inscope diff --adopt</code> pulls these back into the config instead.
                  </p>
                  <ul className="list-inside list-disc font-mono text-sm">
                    {data.adoptable.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                </section>
              )}
              {data.drifts.map((drift) => (
                <section
                  key={drift.label}
                  aria-labelledby={`drift-${drift.label}`}
                  className="space-y-2"
                >
                  <div className="space-y-1">
                    <h2 id={`drift-${drift.label}`} className="font-mono font-semibold">
                      {drift.label}
                    </h2>
                    <p className="text-muted-foreground font-mono text-sm">{drift.path}</p>
                  </div>
                  <DriftDiff drift={drift} />
                </section>
              ))}
            </div>
          )
        }
      </QueryState>
    </PageShell>
  )
}
