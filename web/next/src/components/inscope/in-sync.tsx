import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"

// The empty state for no pending changes, on the machine or in one workspace.
export function InSync({ workspace }: { workspace?: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>In sync</EmptyTitle>
        <EmptyDescription>
          Every file inscope manages{workspace ? ` for ${workspace}` : ""} matches the config.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
