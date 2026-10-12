import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { InscopeFooter, InscopeNav } from "@/components/inscope/sidebar"
import { SidebarShell } from "@/components/shell/sidebar-shell"
import { inscopePaths } from "@/lib/inscope"

// The dashboard is the app's home page and reads this machine's inscope state, so it renders only under `next dev` (Next inlines NODE_ENV: "development" there, "production" in any build, where these paths 404); the API it calls answers only on the local stage and only to loopback.
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "inscope",
  robots: { index: false, follow: false },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV !== "development") notFound()

  return (
    <SidebarShell
      badge="Local, read-only"
      homeHref={inscopePaths.overview}
      nav={<InscopeNav />}
      footer={<InscopeFooter />}
    >
      {children}
    </SidebarShell>
  )
}
