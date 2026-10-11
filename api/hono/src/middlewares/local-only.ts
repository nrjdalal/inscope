import { isLocal } from "@packages/env"
import type { Context, MiddlewareHandler } from "hono"
import { getConnInfo } from "hono/bun"

import { jsonError } from "@/lib/error"

type LocalOnlyOptions = {
  stage: string | undefined
  trustedOrigins: string[]
  // the socket peer, never a forwarded header: X-Forwarded-For is whatever the client sends
  peer?: (c: Context) => string | undefined
}

const socketPeer = (c: Context) => getConnInfo(c).remote.address

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export const isLoopbackHost = (hostname: string): boolean =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost")

export const isLoopbackAddress = (address: string | undefined): boolean =>
  !!address &&
  (address.startsWith("127.") || address === "::1" || address.startsWith("::ffff:127."))

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

// Routes that read this machine's own state: invisible off the local stage, and refused unless the request is addressed to and arrives from loopback, so a web page in the browser cannot reach them through DNS rebinding or a cross-site request.
export const createLocalOnly =
  ({ stage, trustedOrigins, peer = socketPeer }: LocalOnlyOptions): MiddlewareHandler =>
  async (c, next) => {
    if (!isLocal(stage)) return c.notFound()
    if (!isLoopbackHost(new URL(c.req.url).hostname))
      return jsonError(c, 403, "FORBIDDEN", "Only answers requests addressed to localhost")
    let address: string | undefined
    try {
      address = peer(c)
    } catch {
      address = undefined
    }
    if (!isLoopbackAddress(address))
      return jsonError(c, 403, "FORBIDDEN", "Only answers requests from this machine")
    if (c.req.header("sec-fetch-site") === "cross-site")
      return jsonError(c, 403, "FORBIDDEN", "Refuses cross-site requests")
    if (!READ_METHODS.has(c.req.method) && !trustedOrigins.includes(c.req.header("origin") ?? ""))
      return jsonError(c, 403, "FORBIDDEN", "Untrusted Origin")
    await next()
  }
