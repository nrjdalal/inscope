"use client"

import { RiRefreshLine } from "@remixicon/react"
import type { UseQueryResult } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { ApiError } from "@/lib/api/client"

const errorCopy = (error: ApiError): { description: React.ReactNode; title: string } => {
  if (error.code === "INSCOPE_CONFIG_INVALID")
    return { title: "The inscope config is invalid", description: error.message }
  if (error.code === "NETWORK_ERROR")
    return {
      title: "The API is not reachable",
      description: (
        <>
          Start the stack with <code>bun run dev</code>.
        </>
      ),
    }
  if (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
    return {
      title: "Not available here",
      description: "The inscope API only answers on the local stage, from this machine.",
    }
  return { title: "Something went wrong", description: error.message }
}

// The loading, error, and data states every inscope page shares: a bare spinner where the wait is, the API's own message on failure, then the page.
export function QueryState<T>({
  query,
  children,
}: {
  query: UseQueryResult<T, ApiError>
  children: (data: T) => React.ReactNode
}) {
  if (query.isPending) return <Spinner />
  if (query.isError) {
    const { title, description } = errorCopy(query.error)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription className="whitespace-pre-line">{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => query.refetch()}>
            <RiRefreshLine />
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return children(query.data)
}
