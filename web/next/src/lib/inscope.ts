import { type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query"

import { type ApiError, apiClient, unwrap } from "@/lib/api/client"

// "1 skill", "2 skills": a count the dashboard shows, its noun agreeing with it
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

export const inscopeKeys = {
  all: ["inscope"] as const,
  diff: ["inscope", "diff"] as const,
  doctor: ["inscope", "doctor"] as const,
  overview: ["inscope", "overview"] as const,
  status: ["inscope", "status"] as const,
  workspace: (name: string) => ["inscope", "workspaces", name] as const,
}

// Every inscope route spawns claude, gh, or git on this machine, so data stays fresh for a short while, is never refetched on focus, and a failure is shown rather than retried; the error is the API's own { code, message }.
const useInscopeQuery = <T>(
  queryKey: QueryKey,
  call: () => Promise<{ data: T; error: null } | { data: null; error: ApiError }>,
  { enabled = true }: { enabled?: boolean } = {},
) =>
  useQuery<T, ApiError>({
    enabled,
    queryKey,
    queryFn: async () => {
      const result = await call()
      if (result.error) throw result.error
      return result.data
    },
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 10_000,
  })

export const useInscopeOverview = () =>
  useInscopeQuery(inscopeKeys.overview, () => unwrap(apiClient.inscope.$get()))

export const useInscopeStatus = () =>
  useInscopeQuery(inscopeKeys.status, () => unwrap(apiClient.inscope.status.$get()))

export const useInscopeDoctor = () =>
  useInscopeQuery(inscopeKeys.doctor, () => unwrap(apiClient.inscope.doctor.$get()))

export const useInscopeDiff = () =>
  useInscopeQuery(inscopeKeys.diff, () => unwrap(apiClient.inscope.diff.$get()))

export const useInscopeWorkspace = (name: string, options?: { enabled?: boolean }) =>
  useInscopeQuery(
    inscopeKeys.workspace(name),
    () => unwrap(apiClient.inscope.workspaces[":name"].$get({ param: { name } })),
    options,
  )

export const useInscopeRefresh = () => {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: inscopeKeys.all })
}

export type InscopeOverview = NonNullable<ReturnType<typeof useInscopeOverview>["data"]>
export type InscopeWorkspace = InscopeOverview["workspaces"][number]
export type InscopeIdentity = NonNullable<
  ReturnType<typeof useInscopeStatus>["data"]
>["workspaces"][number]
export type InscopeCheck = NonNullable<
  ReturnType<typeof useInscopeDoctor>["data"]
>["checks"][number]
export type InscopeDrift = NonNullable<ReturnType<typeof useInscopeDiff>["data"]>["drifts"][number]
