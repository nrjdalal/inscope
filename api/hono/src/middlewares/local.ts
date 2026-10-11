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

// What a proxy in front of this request says about the hop it relayed. A proxy on this machine connects from loopback, so the socket peer alone would let a rebound or LAN request through it. These headers can only refuse, never admit: a relay must name its client (portless appends it to x-forwarded-for), and every host and client it names must be loopback. `next dev`'s /api forwarding names no client and passes the caller's own Host along, so a request through it is refused outright; the dashboard calls the API directly.
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
  const addresses = [...list("x-forwarded-for"), ...list("x-real-ip"), ...param("for")]
  const hosts = [...list("x-forwarded-host"), ...param("host")]
  const marked =
    forwarded.length > 0 || RELAY_HEADERS.some((name) => c.req.header(name) !== undefined)
  return {
    addresses: addresses.map(addressOf),
    hosts: hosts.map(hostnameOf),
    unnamed: marked && addresses.length === 0,
  }
}

const RELAY_HEADERS = [
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

// Routes that read this machine's own state: invisible off the local stage, and refused unless the request is addressed to and arrives from loopback, directly or through a proxy on this machine that names its loopback client, so a web page cannot reach them through DNS rebinding, the LAN, or a cross-site request.
export const requireLocal =
  ({ peer = socketPeer, stage, trustedOrigins }: RequireLocalOptions): MiddlewareHandler =>
  async (c, next) => {
    if (!isLocal(stage)) return c.notFound()
    const { addresses, hosts, unnamed } = relayed(c)
    if (![hostnameOf(c.req.header("host") ?? ""), ...hosts].every(isLoopbackHost))
      return jsonError(c, 403, "FORBIDDEN", "Only answers requests addressed to localhost")
    let address: string | undefined
    try {
      address = peer(c)
    } catch {
      address = undefined
    }
    if (unnamed || ![address, ...addresses].every(isLoopbackAddress))
      return jsonError(c, 403, "FORBIDDEN", "Only answers requests from this machine")
    if (c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site")
      return jsonError(c, 403, "FORBIDDEN", "Refuses cross-site requests")
    if (!READ_METHODS.has(c.req.method) && !trustedOrigins.includes(c.req.header("origin") ?? ""))
      return jsonError(c, 403, "FORBIDDEN", "Untrusted Origin")
    await next()
  }
