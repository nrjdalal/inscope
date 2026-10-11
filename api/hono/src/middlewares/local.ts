import { isLocal } from "@packages/env"
import type { Context, MiddlewareHandler } from "hono"
import { getConnInfo } from "hono/bun"

import { jsonError } from "@/lib/error"

type RequireLocalOptions = {
  // the socket peer, never a forwarded header: a client writes those itself
  peer?: (c: Context) => string | undefined
  stage: string | undefined
  trustedOrigins: string[]
}

const socketPeer = (c: Context) => getConnInfo(c).remote.address

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export const isLoopbackHost = (hostname: string): boolean =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost")

export const isLoopbackAddress = (address: string | undefined): boolean =>
  !!address &&
  (address.startsWith("127.") || address === "::1" || address.startsWith("::ffff:127."))

// "host:port" or "[v6]:port" as a header carries it, to the hostname URL reports ("" when it does not parse)
const hostnameOf = (host: string): string => {
  try {
    return new URL(`http://${host.trim().replace(/^"|"$/g, "")}`).hostname
  } catch {
    return ""
  }
}

// "1.2.3.4", "1.2.3.4:5678", "[::1]:5678", or a quoted RFC 7239 node, to the bare address
const addressOf = (node: string): string => {
  const value = node.trim().replace(/^"|"$/g, "")
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"))
  return value.split(":").length === 2 ? value.split(":")[0] : value
}

// Every host and client a proxy in front of this request says it relayed for. A proxy on this machine (`next dev` forwarding /api, portless) connects from loopback, so the socket peer alone would let a rebound or LAN request through it; these headers name the hop it came from. They can only refuse, never admit: a request without them is judged on its own Host and peer.
const relayed = (c: Context) => {
  const list = (name: string) =>
    (c.req.header(name) ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  const forwarded = list("forwarded").flatMap((element) =>
    element.split(";").map((pair) => pair.trim()),
  )
  const param = (key: string) =>
    forwarded
      .filter((pair) => pair.toLowerCase().startsWith(`${key}=`))
      .map((pair) => pair.slice(key.length + 1))
  return {
    addresses: [...list("x-forwarded-for"), ...list("x-real-ip"), ...param("for")].map(addressOf),
    hosts: [...list("x-forwarded-host"), ...param("host")].map(hostnameOf),
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

// Routes that read this machine's own state: invisible off the local stage, and refused unless the request is addressed to and arrives from loopback, directly or through a proxy on this machine, so a web page cannot reach them through DNS rebinding, the LAN, or a cross-site request.
export const requireLocal =
  ({ peer = socketPeer, stage, trustedOrigins }: RequireLocalOptions): MiddlewareHandler =>
  async (c, next) => {
    if (!isLocal(stage)) return c.notFound()
    const { addresses, hosts } = relayed(c)
    if (![hostnameOf(new URL(c.req.url).host), ...hosts].every(isLoopbackHost))
      return jsonError(c, 403, "FORBIDDEN", "Only answers requests addressed to localhost")
    let address: string | undefined
    try {
      address = peer(c)
    } catch {
      address = undefined
    }
    if (![address, ...addresses].every(isLoopbackAddress))
      return jsonError(c, 403, "FORBIDDEN", "Only answers requests from this machine")
    if (c.req.header("sec-fetch-site") === "cross-site")
      return jsonError(c, 403, "FORBIDDEN", "Refuses cross-site requests")
    if (!READ_METHODS.has(c.req.method) && !trustedOrigins.includes(c.req.header("origin") ?? ""))
      return jsonError(c, 403, "FORBIDDEN", "Untrusted Origin")
    await next()
  }
