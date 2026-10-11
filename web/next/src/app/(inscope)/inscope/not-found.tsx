import { RouteNotFound } from "@/components/common/route-not-found"
import { PageShell } from "@/components/shell/page-shell"

// Dashboard-scoped not-found, so an unknown path or workspace resolves inside the shell instead of swapping the whole document for the global 404.
export default function NotFound() {
  return (
    <PageShell size="lg" className="flex flex-1 flex-col justify-center">
      <RouteNotFound
        action="Back to workspaces"
        description="No such page or workspace in this machine's inscope config."
        href="/inscope"
        title="Not found"
      />
    </PageShell>
  )
}
