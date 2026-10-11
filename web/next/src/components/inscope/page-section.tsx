// One titled section of a dashboard page: a heading the region is named by (h2, or h3 for a section inside another), an optional monospace line under it (the file or folder the section describes), then its content.
export function PageSection({
  children,
  description,
  id,
  level = 2,
  title,
}: {
  children: React.ReactNode
  description?: React.ReactNode
  id: string
  level?: 2 | 3
  title: React.ReactNode
}) {
  const Heading = level === 3 ? "h3" : "h2"
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="space-y-1">
        <Heading id={id} className="font-semibold">
          {title}
        </Heading>
        {description && <p className="text-muted-foreground font-mono text-sm">{description}</p>}
      </div>
      {children}
    </section>
  )
}
