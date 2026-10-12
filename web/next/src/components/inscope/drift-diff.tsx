import { cn } from "cn"

import { PageSection } from "@/components/inscope/page-section"
import type { InscopeDrift } from "@/lib/inscope"

const lineClass = (line: string) =>
  line.startsWith("+ ")
    ? "text-success"
    : line.startsWith("- ")
      ? "text-destructive"
      : "text-muted-foreground"

// One pending change as `inscope diff` prints it: added lines in success, removed in destructive, context muted; credential values arrive already redacted.
function DriftDiff({ drift }: { drift: InscopeDrift }) {
  if (drift.error) return <p className="text-destructive text-sm">{drift.error}</p>
  return (
    <pre
      tabIndex={0}
      aria-label={`Changes to ${drift.path}`}
      className="bg-muted overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed"
    >
      {(drift.diff ?? "").split("\n").map((line, index) => (
        <span key={index} className={cn("block", lineClass(line))}>
          {line || " "}
        </span>
      ))}
    </pre>
  )
}

// A pending change as its own section: its label as the heading, the file it changes beneath, then the diff.
export function DriftSection({ drift, level }: { drift: InscopeDrift; level?: 2 | 3 }) {
  return (
    <PageSection
      id={`change-${drift.label}`}
      level={level}
      title={<span className="font-mono">{drift.label}</span>}
      description={drift.path}
    >
      <DriftDiff drift={drift} />
    </PageSection>
  )
}
