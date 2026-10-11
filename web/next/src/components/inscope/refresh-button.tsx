"use client"

import { RiRefreshLine } from "@remixicon/react"
import { useIsFetching } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { inscopeKeys, useInscopeRefresh } from "@/lib/inscope"

// Re-reads this machine: the pages never refetch on their own, so a change made in the terminal shows after a click.
export function RefreshButton() {
  const refresh = useInscopeRefresh()
  const fetching = useIsFetching({ queryKey: inscopeKeys.all }) > 0
  return (
    <Button variant="outline" onClick={() => refresh()} disabled={fetching}>
      {fetching ? <Spinner /> : <RiRefreshLine />}
      Refresh
    </Button>
  )
}
