import { StatusBadge } from "@/components/inscope/status-badge"
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import type { InscopeWorkspace } from "@/lib/inscope"

// A workspace's MCP servers by name: inscope's own and any added by hand, and whether each is in the file yet.
export function McpServerList({ servers }: { servers: InscopeWorkspace["mcp"]["servers"] }) {
  if (!servers.length) return <p className="text-muted-foreground text-sm">No MCP servers.</p>
  return (
    <ItemGroup className="gap-2">
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
