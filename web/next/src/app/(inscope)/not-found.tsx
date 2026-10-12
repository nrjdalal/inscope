import { RouteNotFound } from "@/components/common/route-not-found"
import { PageShell } from "@/components/shell/page-shell"
import { inscopePaths } from "@/lib/inscope"

// Dashboard-scoped not-found, so a workspace that does not exist resolves inside the shell instead of swapping the whole document for the global 404 (which an unknown path gets, the dashboard sharing the site's root).
export default function NotFound() {
  return (
    <PageShell size="lg" className="flex flex-1 flex-col justify-center">
      <RouteNotFound
        action="Back to workspaces"
        description="No such workspace in this machine's inscope config."
        href={inscopePaths.overview}
        title="Not found"
      />
    </PageShell>
  )
}
