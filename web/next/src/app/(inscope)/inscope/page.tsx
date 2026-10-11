"use client"

import { RiArrowRightSLine } from "@remixicon/react"
import Link from "next/link"

import { NoWorkspaces } from "@/components/inscope/no-workspaces"
import { QueryState } from "@/components/inscope/query-state"
import { RefreshButton } from "@/components/inscope/refresh-button"
import { WorkspaceBadges } from "@/components/inscope/workspace-badges"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { useInscopeOverview, useInscopeStatus } from "@/lib/inscope"

export default function Page() {
  const overview = useInscopeOverview()
  const status = useInscopeStatus()

  return (
    <PageShell size="lg">
      <PageHeader
        title="Workspaces"
        description="The identity inscope resolves in each directory on this machine."
        actions={<RefreshButton />}
      />
      <QueryState query={overview}>
        {(data) =>
          data.workspaces.length === 0 ? (
            <NoWorkspaces configExists={data.config.exists} />
          ) : (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">
                From <code>{data.config.path}</code>
                {data.config.bypass && ", with permission prompts skipped in isolated logins"}.
              </p>
              <ItemGroup className="gap-3">
                {data.workspaces.map((workspace) => (
                  <Item
                    key={workspace.name}
                    variant="outline"
                    render={<Link href={`/inscope/workspaces/${workspace.name}`} />}
                  >
                    <ItemContent className="gap-2">
                      <ItemTitle>
                        {workspace.name}
                        <span className="text-muted-foreground font-mono font-normal">
                          {workspace.path}
                        </span>
                      </ItemTitle>
                      <ItemDescription>
                        {workspace.servers.length
                          ? `MCP servers: ${workspace.servers.join(", ")}`
                          : "No MCP servers"}
                      </ItemDescription>
                      <WorkspaceBadges
                        workspace={workspace}
                        identity={status.data?.workspaces.find((i) => i.name === workspace.name)}
                        identityPending={status.isPending}
                      />
                    </ItemContent>
                    <ItemActions>
                      <RiArrowRightSLine className="text-muted-foreground size-4" />
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </div>
          )
        }
      </QueryState>
    </PageShell>
  )
}
