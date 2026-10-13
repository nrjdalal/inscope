import { FullDescription } from "@/components/inscope/full-description"
import { StatusBadge } from "@/components/inscope/status-badge"
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import type { InscopeCheck } from "@/lib/inscope"

const statusLabel = { fail: "Fail", ok: "OK", warn: "Warn" } as const

// Each check with its status and, when it has one, its detail.
export function CheckList({ checks }: { checks: InscopeCheck[] }) {
  return (
    <ItemGroup>
      {checks.map((check, index) => (
        <Item key={`${check.label}-${index}`} variant="outline" size="sm">
          <ItemContent>
            <ItemTitle>
              <StatusBadge tone={check.status}>{statusLabel[check.status]}</StatusBadge>
              <span className="font-mono">{check.label}</span>
            </ItemTitle>
            {check.detail && (
              <FullDescription className="font-mono">{check.detail}</FullDescription>
            )}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}
