// One titled section of a dashboard page: an h2 the region is named by, an optional monospace line under it (the file or folder the section describes), then its content.
export function PageSection({
  children,
  description,
  id,
  title,
}: {
  children: React.ReactNode
  description?: React.ReactNode
  id: string
  title: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="space-y-1">
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {description && <p className="text-muted-foreground font-mono text-sm">{description}</p>}
      </div>
      {children}
    </section>
  )
}
