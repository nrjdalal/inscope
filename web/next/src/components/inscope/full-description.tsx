import { cn } from "cn"

import { ItemDescription } from "@/components/ui/item"

// An item's description that can hold a long path or URL (a skill's source, a check's detail): it wraps anywhere and is never clamped, so the whole value fits a phone.
export function FullDescription({
  className,
  ...props
}: React.ComponentProps<typeof ItemDescription>) {
  return <ItemDescription className={cn("line-clamp-none wrap-anywhere", className)} {...props} />
}
