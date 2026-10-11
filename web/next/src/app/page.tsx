import { features, site } from "@packages/config/site"
import { redirect } from "next/navigation"

// Fresh fork: the waitlist capture when the waitlist feature is on, otherwise a plain landing page. Replace this with your real home when ready.
export default function Home() {
  if (features.waitlist) redirect("/waitlist")

  return (
    <main className="flex min-h-svh flex-col items-center justify-center p-8 text-center">
      <div className="mx-auto flex w-full max-w-xl flex-col items-center">
        <h1 className="mb-4 text-5xl font-bold tracking-tight sm:text-6xl">{site.name}</h1>
        <p className="text-muted-foreground max-w-md text-lg">{site.tagline}</p>
      </div>
    </main>
  )
}
