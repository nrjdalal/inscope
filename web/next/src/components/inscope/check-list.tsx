import { StatusBadge } from "@/components/inscope/status-badge"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import type { InscopeCheck } from "@/lib/inscope"

const statusLabel = { fail: "Fail", ok: "OK", warn: "Warn" } as const

// Each check with its status; a detail can hold a long path, so it wraps anywhere and is never clamped.
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
              <ItemDescription className="line-clamp-none font-mono wrap-anywhere">
                {check.detail}
              </ItemDescription>
            )}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}
