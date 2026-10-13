import { Badge } from "@/components/ui/badge"

export type Tone = "fail" | "muted" | "ok" | "warn"

// One status pill for the whole dashboard over the shared Badge, on the existing tokens only: success and destructive carry the color, a warning stays a plain outline.
export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  if (tone === "ok")
    return (
      <Badge variant="outline" className="border-success/20 bg-success/10 text-success">
        {children}
      </Badge>
    )
  if (tone === "fail") return <Badge variant="destructive">{children}</Badge>
  return <Badge variant={tone === "warn" ? "outline" : "secondary"}>{children}</Badge>
}
