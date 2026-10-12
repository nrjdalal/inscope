import { describe, expect, test } from "bun:test"

import {
  isCredentialName,
  redactMcpText,
  redactString,
  skillSourceLabel,
} from "../../../../../api/hono/src/lib/redact"

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
      "Authorization: <redacted>",
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
    expect(redacted({ args: ["--header", "Authorization: token lower-1"] }).args).toEqual([
      "--header",
      "Authorization: <redacted>",
    ])
    expect(redactString("curl -H 'authorization: bearer lowercase-token-1'")).toBe(
      "curl -H 'authorization: <redacted>'",
    )
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

  test("withholds JSON inside a string, a header without a space, --env=K=V, and every cookie", () => {
    expect(
      redacted({
        args: [
          "--config",
          '{"apiKey":"json-1","region":"eu"}',
          "-H",
          "X-API-Key:nospace-1",
          "--env=REGION=inline-env-1",
          "-H",
          "Cookie: a=1; session=cookie-2",
          "postgresql://user:x@at-sign-1@db.example/x",
        ],
      }).args,
    ).toEqual([
      "--config",
      '{"apiKey":"<redacted>","region":"eu"}',
      "-H",
      "X-API-Key:<redacted>",
      "--env=REGION=<redacted>",
      "-H",
      "Cookie: <redacted>",
      "postgresql://<redacted>@db.example/x",
    ])
  })

  test("keeps what is not a credential readable: server names, client ids, ports, toggles", () => {
    const doc = {
      mcpServers: {
        auth0: { type: "http", url: "https://auth0.example.com/mcp" },
        keycloak: {
          type: "http",
          url: "https://sso.example.com/mcp",
          oauth: { callbackPort: 33418, clientId: "dashboard-client" },
        },
        "slack-work": {
          env: {
            SLACK_MCP_ALLOW_WRITE: "false",
            SLACK_MCP_XOXP_TOKEN: "${SLACK_MCP_XOXP_TOKEN:-}",
          },
        },
      },
    }
    expect(redacted(doc)).toEqual(doc)
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

describe("isCredentialName", () => {
  test("judges each word of a name, whatever its case style", () => {
    for (const name of [
      "apiKey",
      "API_KEY",
      "X-Api-Key",
      "DB_PASSWORD",
      "dbpassword",
      "githubToken",
      "GITHUB_PAT",
      "connectionString",
      "SENTRY_DSN",
      "Authorization",
      "cookie",
      "credentials",
      "clientSecret",
      "--api-key",
      "pwd",
      "--passphrase",
      "JWT_SECRET",
      "jwt",
      "clientCreds",
    ])
      expect(`${name} ${isCredentialName(name)}`).toBe(`${name} true`)
    for (const name of [
      "keycloak",
      "oauth",
      "auth0",
      "clientId",
      "callbackPort",
      "keychain",
      "SLACK_MCP_ALLOW_WRITE",
      "url",
      "region",
      "monkey",
      "passport-bridge",
    ])
      expect(`${name} ${isCredentialName(name)}`).toBe(`${name} false`)
  })
})

describe("redactString", () => {
  test("covers an adopted value: a URL's query and user info inside free text", () => {
    expect(redactString("work: linear.url = https://mcp.linear.app/sse?key=k1")).toBe(
      "work: linear.url = https://mcp.linear.app/sse?<redacted>",
    )
    expect(redactString("work: x.url = http://a:b@h.example")).toBe(
      "work: x.url = http://<redacted>@h.example",
    )
    expect(redactString("work: slack.package = @nrjdalal/slack-mcp-server")).toBe(
      "work: slack.package = @nrjdalal/slack-mcp-server",
    )
  })
})

describe("redactString on a URL's path", () => {
  test("withholds a long opaque segment, the token some hosted servers carry in the URL itself", () => {
    expect(
      redactString("https://mcp.zapier.com/api/mcp/s/a1b2c3d4-path-token-should-be-redacted/mcp"),
    ).toBe("https://mcp.zapier.com/api/mcp/s/<redacted>/mcp")
    expect(redactString("wss://hooks.example.com/v2/hook-token-should-be-redacted-01")).toBe(
      "wss://hooks.example.com/v2/<redacted>",
    )
  })

  test("keeps a plain path, and an opaque word outside a URL", () => {
    for (const value of [
      "https://mcp.linear.app/sse-old",
      "https://api.githubcopilot.com/mcp/",
      "https://docs.example.com/guides/getting-started-with-everything",
      "@nrjdalal/slack-mcp-server@latest",
      "a1b2c3d4-not-in-a-url-at-all-0000",
    ])
      expect(redactString(value)).toBe(value)
  })
})

describe("skillSourceLabel", () => {
  test("withholds a git URL's credentials and keeps its subdir and ref", () => {
    expect(
      skillSourceLabel({
        name: "audit",
        ref: "main",
        source: {
          kind: "git",
          url: "https://x-access-token:skill-should-be-redacted@git.example.com/o/r.git",
        },
        subdir: "skills/audit",
      }),
    ).toBe("https://<redacted>@git.example.com/o/r.git#skills/audit@main")
    expect(
      skillSourceLabel({
        name: "audit",
        source: { kind: "github", repo: "o/r" },
        subdir: "skills/audit",
      }),
    ).toBe("o/r#skills/audit")
  })
})

describe("redactString on a quoted value", () => {
  test("withholds a quoted value in a name=value or a header, keeping its quotes", () => {
    expect(redactString('API_KEY="quoted-should-be-redacted"')).toBe('API_KEY="<redacted>"')
    expect(redactString("--password='single-should-be-redacted'")).toBe("--password='<redacted>'")
    expect(redactString('export API_TOKEN="with space should-be-redacted"')).toBe(
      'export API_TOKEN="<redacted>"',
    )
    expect(redactString('API_KEY="unclosed-should-be-redacted')).toBe('API_KEY="<redacted>')
    expect(redactString('X-Api-Key: "header-should-be-redacted"')).toBe('X-Api-Key: "<redacted>"')
    expect(redactString("token: 'single-header-should-be-redacted' rest")).toBe(
      "token: '<redacted>' rest",
    )
  })

  test("keeps a value filled in at run time, the hook's own exports included", () => {
    for (const value of [
      'export GITHUB_TOKEN="$tok" GH_TOKEN="$tok"',
      'GH_TOKEN="$(gh auth token -u demo)"',
      'Authorization: "Bearer %s"',
      "clearing any inherited token\n__inscope_resolve_identity",
    ])
      expect(redactString(value)).toBe(value)
  })
})

describe("redactString on a vendor token", () => {
  // put together here, so no secret scanner reads a token in this file
  const body = "0123456789abcdefghijABCDEFGHIJklmnopqrstuvwxyz0123456789"

  test("withholds a token its prefix gives away, even as a bare argument", () => {
    for (const token of [
      `ghp_${body.slice(0, 36)}`,
      `github_pat_${body.slice(0, 40)}`,
      `sk-proj-${body.slice(0, 40)}`,
      `sk_live_${body.slice(0, 24)}`,
      `xoxb-${body.slice(0, 20)}`,
      `AKIA${"ABCDEFGHIJ012345"}`,
      `ntn_${body.slice(0, 46)}`,
      `lin_api_${body.slice(0, 40)}`,
      `glpat-${body.slice(0, 20)}`,
      `npm_${body.slice(0, 36)}`,
      `AIza${body.slice(0, 35)}`,
      `hf_${body.slice(0, 34)}`,
    ])
      expect(`${token}: ${redactString(`npx -y some-server ${token} --flag`)}`).toBe(
        `${token}: npx -y some-server <redacted> --flag`,
      )
  })

  test("keeps a word that only starts like one", () => {
    for (const value of ["sk-learn", "ghp_short", "xoxo", "npm_config_cache", "AKIA"])
      expect(redactString(value)).toBe(value)
  })
})
