import { describe, expect, test } from "bun:test"

import { isLoopbackAddress, isLoopbackHost } from "../../../../../api/hono/src/middlewares/local"

// The request-level behavior of requireLocal, forwarding headers included, is driven through the mounted router in tests/api/hono/src/routers/inscope.test.ts; these are its two predicates.

describe("isLoopbackHost", () => {
  test("accepts loopback names and the portless .localhost names", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "inscope.localhost",
      "api.inscope.localhost",
    ])
      expect(isLoopbackHost(host)).toBe(true)
  })

  test("refuses every other name, a lookalike or a trailing dot included", () => {
    for (const host of [
      "",
      "localhost.",
      "localhost.evil.example",
      "evil.example",
      "0.0.0.0",
      "127.0.0.2",
      "192.168.1.2",
    ])
      expect(isLoopbackHost(host)).toBe(false)
  })
})

describe("isLoopbackAddress", () => {
  test("accepts IPv4 loopback, IPv6 loopback, and IPv4-mapped loopback", () => {
    for (const address of ["127.0.0.1", "127.0.1.1", "::1", "::ffff:127.0.0.1"])
      expect(isLoopbackAddress(address)).toBe(true)
  })

  test("refuses an unreadable peer and every other address", () => {
    for (const address of [
      undefined,
      "",
      "unknown",
      "0.0.0.0",
      "10.0.0.1",
      "::ffff:10.0.0.1",
      "fe80::1",
    ])
      expect(isLoopbackAddress(address)).toBe(false)
  })
})
