import { cn } from "cn"

import type { InscopeDrift } from "@/lib/inscope"

const lineClass = (line: string) =>
  line.startsWith("+ ")
    ? "text-success"
    : line.startsWith("- ")
      ? "text-destructive"
      : "text-muted-foreground"

// One pending change as `inscope diff` prints it: added lines in success, removed in destructive, context muted; credential values arrive already redacted.
export function DriftDiff({ drift }: { drift: InscopeDrift }) {
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
