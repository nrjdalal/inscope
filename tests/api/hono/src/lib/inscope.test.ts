import { describe, expect, test } from "bun:test"

import { redactMcpText, redactStrings } from "../../../../../api/hono/src/lib/inscope"

const redacted = (doc: unknown) => JSON.parse(redactMcpText(JSON.stringify(doc)))

describe("redactMcpText", () => {
  test("withholds every env and headers value, keeping one that only names a variable", () => {
    const doc = redacted({
      mcpServers: {
        a: {
          env: {
            EMPTY_DEFAULT: "${SLACK_MCP_XOXP_TOKEN:-}",
            LITERAL: "sk-1",
            PLAIN: "${MY_TOKEN}",
            WITH_DEFAULT: "${T:-sk-2}",
          },
          headers: { Authorization: "Bearer sk-3", "X-Org": "acme" },
        },
      },
    })
    expect(doc.mcpServers.a).toEqual({
      env: {
        EMPTY_DEFAULT: "${SLACK_MCP_XOXP_TOKEN:-}",
        LITERAL: "<redacted>",
        PLAIN: "${MY_TOKEN}",
        WITH_DEFAULT: "<redacted>",
      },
      headers: { Authorization: "<redacted>", "X-Org": "<redacted>" },
    })
  })

  test("withholds anything under a key that names a credential, nested and non-string values too", () => {
    const doc = redacted({
      auth: { user: "me", pwd: "p" },
      cookie: "c",
      credentials: ["x", "y"],
      GITHUB_PAT: "ghp_1",
      nested: { secrets: { prod: "sk-4" }, apiKey: 1234 },
      keep: { name: "visible" },
    })
    expect(doc).toEqual({
      auth: { user: "<redacted>", pwd: "<redacted>" },
      cookie: "<redacted>",
      credentials: ["<redacted>", "<redacted>"],
      GITHUB_PAT: "<redacted>",
      nested: { secrets: { prod: "<redacted>" }, apiKey: "<redacted>" },
      keep: { name: "visible" },
    })
  })

  test("withholds the value after a credential flag, and the value of --flag=value", () => {
    expect(
      redacted({
        args: ["-y", "pkg", "--api-key", "sk-5", "--token=sk-6", "--verbose", "on", "-p", "s3cret"],
      }).args,
    ).toEqual([
      "-y",
      "pkg",
      "--api-key",
      "<redacted>",
      "--token=<redacted>",
      "--verbose",
      "on",
      "-p",
      "s3cret",
    ])
  })

  test("withholds the query and user info of a URL, wherever it sits", () => {
    expect(
      redacted({
        url: "https://mcp.example.com/sse?token=t1&x=2",
        args: ["https://user:pass@host.example/path"],
        plain: "https://mcp.example.com/mcp",
      }),
    ).toEqual({
      url: "https://mcp.example.com/sse?<redacted>",
      args: ["https://<redacted>@host.example/path"],
      plain: "https://mcp.example.com/mcp",
    })
  })

  test("withholds the credentials common MCP command lines carry", () => {
    expect(
      redacted({
        args: [
          "postgresql://user:pg-pass@localhost/db",
          "--header",
          "Authorization: Bearer header-bearer-1",
          "-H",
          "X-Api-Key: header-key-1",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN=docker-env-1",
          "--env",
          "REGION=eu",
          "--connectionString",
          "Server=x;Password=conn-1",
          "API_TOKEN=inline-1",
          "https://mcp.example.com/cb#access_token=fragment-1",
          "--log-level",
          "info",
        ],
      }).args,
    ).toEqual([
      "postgresql://<redacted>@localhost/db",
      "--header",
      "Authorization: Bearer <redacted>",
      "-H",
      "X-Api-Key: <redacted>",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN=<redacted>",
      "--env",
      "REGION=<redacted>",
      "--connectionString",
      "<redacted>",
      "API_TOKEN=<redacted>",
      "https://mcp.example.com/cb#<redacted>",
      "--log-level",
      "info",
    ])
  })

  test("withholds a token typed into a string inscope does not own, like a hand-written headersHelper", () => {
    expect(
      redacted({ headersHelper: `echo '{"Authorization":"Bearer helper-bearer-1"}'` })
        .headersHelper,
    ).toBe(`echo '{"Authorization":"Bearer <redacted>"}'`)
  })

  test("withholds user info, queries, and fragments in any URL scheme", () => {
    expect(
      redacted({
        a: "mongodb+srv://u:p@cluster.example/db?authSource=admin",
        b: "redis://:pw@cache.example:6379",
        c: "wss://u:pw@socket.example/feed",
      }),
    ).toEqual({
      a: "mongodb+srv://<redacted>@cluster.example/db?<redacted>",
      b: "redis://<redacted>@cache.example:6379",
      c: "wss://<redacted>@socket.example/feed",
    })
  })

  test("leaves inscope's own servers readable", () => {
    const doc = {
      mcpServers: {
        "github-work": {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headersHelper:
            'printf \'{"Authorization":"Bearer %s"}\' "$(gh auth token -u \'demo-work\' 2>/dev/null)"',
        },
      },
    }
    expect(redacted(doc)).toEqual(doc)
  })

  test("re-serializes the way apply writes, and withholds text that does not parse", () => {
    expect(redactMcpText('{"a":1}')).toBe('{\n  "a": 1\n}\n')
    expect(redactMcpText("")).toBe("")
    expect(redactMcpText('{"token": "sk-7"')).toBe("<redacted>")
  })
})

describe("redactStrings", () => {
  test("covers an adopted value: a URL's query and user info inside free text", () => {
    expect(redactStrings("work: linear.url = https://mcp.linear.app/sse?key=k1")).toBe(
      "work: linear.url = https://mcp.linear.app/sse?<redacted>",
    )
    expect(redactStrings("work: x.url = http://a:b@h.example")).toBe(
      "work: x.url = http://<redacted>@h.example",
    )
    expect(redactStrings("work: slack.package = @nrjdalal/slack-mcp-server")).toBe(
      "work: slack.package = @nrjdalal/slack-mcp-server",
    )
  })
})
