// One titled section of a dashboard page: an h2 the region is named by, then its content.
export function PageSection({
  children,
  id,
  title,
}: {
  children: React.ReactNode
  id: string
  title: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}
