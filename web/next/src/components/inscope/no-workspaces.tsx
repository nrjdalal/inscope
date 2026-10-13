import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"

// The one empty state for a machine with no workspace yet, whether or not the config file exists.
export function NoWorkspaces({ configExists }: { configExists: boolean }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{configExists ? "No workspaces yet" : "No inscope config yet"}</EmptyTitle>
        <EmptyDescription>
          Map a directory from a terminal with <code>inscope add &lt;path&gt;</code>, then refresh.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
