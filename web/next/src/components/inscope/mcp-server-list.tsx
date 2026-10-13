import { StatusBadge } from "@/components/inscope/status-badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import type { InscopeWorkspace } from "@/lib/inscope"

// A workspace's MCP servers by name: inscope's own and any added by hand, and whether each is in the file yet.
export function McpServerList({ servers }: { servers: InscopeWorkspace["mcp"]["servers"] }) {
  if (!servers.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No MCP servers</EmptyTitle>
          <EmptyDescription>
            Neither the config nor the file names one for this workspace.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <ItemGroup>
      {servers.map((server) => (
        <Item key={server.name} variant="outline" size="sm">
          <ItemContent>
            <ItemTitle>
              <span className="font-mono">{server.name}</span>
              <StatusBadge tone="muted">{server.managed ? "inscope" : "yours"}</StatusBadge>
              {!server.written && <StatusBadge tone="warn">Not written</StatusBadge>}
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}
