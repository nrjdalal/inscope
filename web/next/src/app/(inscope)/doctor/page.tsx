"use client"

import { CheckList } from "@/components/inscope/check-list"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { StatusBadge } from "@/components/inscope/status-badge"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { plural, useInscopeDoctor } from "@/lib/inscope"

export default function Page() {
  const doctor = useInscopeDoctor()

  return (
    <PageShell size="lg">
      <PageHeader
        title="Doctor"
        description="The checks inscope doctor runs: tokens, identities, the hook, and skill links."
        actions={<RefreshButton />}
      />
      <QueryState query={doctor}>
        {(data) =>
          data.checks.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing to check</EmptyTitle>
                <EmptyDescription>There is no inscope config on this machine yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <StatusBadge tone="ok">{data.summary.ok} passed</StatusBadge>
                <StatusBadge tone={data.summary.warn ? "warn" : "muted"}>
                  {plural(data.summary.warn, "warning")}
                </StatusBadge>
                <StatusBadge tone={data.summary.fail ? "fail" : "muted"}>
                  {data.summary.fail} failed
                </StatusBadge>
              </div>
              <CheckList checks={data.checks} />
            </div>
          )
        }
      </QueryState>
    </PageShell>
  )
}
