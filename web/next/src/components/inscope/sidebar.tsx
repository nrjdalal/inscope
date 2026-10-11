"use client"

import {
  RiFileEditLine,
  RiFolderUserLine,
  RiSparklingLine,
  RiStethoscopeLine,
  type RemixiconComponentType,
} from "@remixicon/react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { ModeToggle } from "@/components/common/mode-toggle"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { isActive } from "@/lib/utils"

type InscopeNavItem = { exact?: boolean; icon: RemixiconComponentType; title: string; url: string }

const navGroups: { items: InscopeNavItem[]; label: string }[] = [
  {
    items: [
      // the overview owns /inscope and every /inscope/workspaces/<name> under it
      { icon: RiFolderUserLine, title: "Workspaces", url: "/inscope" },
      { exact: false, icon: RiSparklingLine, title: "Skills", url: "/inscope/skills" },
    ],
    label: "Inspect",
  },
  {
    items: [
      { exact: false, icon: RiStethoscopeLine, title: "Doctor", url: "/inscope/doctor" },
      { exact: false, icon: RiFileEditLine, title: "Pending changes", url: "/inscope/diff" },
    ],
    label: "Verify",
  },
]

const workspacesActive = (pathname: string | null) =>
  isActive(pathname, "/inscope") || (pathname ?? "").startsWith("/inscope/workspaces/")

export function InscopeNav() {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()
  const close = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <>
      {navGroups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel className="pl-2.5">{group.label}</SidebarGroupLabel>
          <SidebarMenu className="space-y-0.5">
            {group.items.map((item) => (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  isActive={
                    item.url === "/inscope"
                      ? workspacesActive(pathname)
                      : isActive(pathname, item.url, { exact: item.exact })
                  }
                  tooltip={item.title}
                  className="data-active:font-normal"
                  render={<Link href={item.url} onClick={close} />}
                >
                  <item.icon />
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  )
}

// Right-aligned: `next dev`, the only place this renders, floats its indicator over the bottom-left corner.
export function InscopeFooter() {
  return (
    <div className="flex items-center justify-end gap-2 px-1.5 group-data-[collapsible=icon]:hidden">
      <span className="text-muted-foreground text-xs">Read-only</span>
      <ModeToggle />
    </div>
  )
}
