import { createEmulator, defineEmulator } from "emulate"

// A stateful stand-in for Anthropic's Messages API, built on vercel-labs/emulate's
// custom-emulator API (emulate ships no Anthropic service). Each credential (an
// x-api-key or a Bearer token) maps to an "account" that answers with its own label,
// so a test can see which account served every turn, and an account can run out of
// quota after N turns, answering 429 like a subscription that hit its limit. Enough of
// the API for the real Claude Code CLI to hold a conversation through it: streaming
// and non-streaming /v1/messages, /v1/messages/count_tokens, and /v1/models.
export type AccountBehavior = {
  label: string
  // Turns this account serves before answering 429 (unset: unlimited).
  quota?: number
}

export type MessagesRequest = {
  credential: string | null
  via: "x-api-key" | "bearer" | null
  label: string | null
  status: number
  stream: boolean
  model: string | null
  turns: number
  userAgent: string | null
  beta: string | null
  sessionId: string | null
  oauthBeta: boolean
}

export type MessagesState = {
  accounts: Record<string, AccountBehavior & { used: number }>
  requests: MessagesRequest[]
}

const err = (type: string, message: string) => ({ type: "error", error: { type, message } })

const sse = (events: [string, unknown][]) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")

const messages = defineEmulator<MessagesState>({
  name: "anthropic-messages",
  state: () => ({ accounts: {}, requests: [] }),
  setup({ app, state }) {
    app.get("/v1/models", (c) =>
      c.json({
        data: [{ type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
        has_more: false,
      }),
    )
    app.post("/v1/messages/count_tokens", (c) => c.json({ input_tokens: 12 }))
    app.post("/v1/messages", async (c) => {
      const apiKey = c.req.header("x-api-key") ?? null
      const auth = c.req.header("authorization") ?? null
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null
      const credential = apiKey ?? bearer
      const body = (await c.req.json().catch(() => ({}))) as Record<string, any>
      const beta = c.req.header("anthropic-beta") ?? null
      const record = (status: number, label: string | null) =>
        state.requests.push({
          credential,
          via: apiKey ? "x-api-key" : bearer ? "bearer" : null,
          label,
          status,
          stream: body.stream === true,
          model: typeof body.model === "string" ? body.model : null,
          turns: Array.isArray(body.messages) ? body.messages.length : 0,
          userAgent: c.req.header("user-agent") ?? null,
          beta,
          sessionId: c.req.header("x-claude-code-session-id") ?? null,
          oauthBeta: Boolean(beta?.includes("oauth-")),
        })
      const account = credential ? state.accounts[credential] : undefined
      if (!account) {
        record(401, null)
        return c.json(err("authentication_error", "invalid x-api-key"), 401)
      }
      if (account.quota !== undefined && account.used >= account.quota) {
        record(429, account.label)
        c.header("retry-after", "3600")
        c.header("anthropic-ratelimit-unified-status", "rejected")
        return c.json(err("rate_limit_error", `${account.label} has reached its usage limit`), 429)
      }
      account.used++
      record(200, account.label)
      const text = `answered by ${account.label}`
      const model = typeof body.model === "string" ? body.model : "claude-haiku-4-5"
      const id = `msg_${account.label}_${account.used}`
      const usage = { input_tokens: 12, output_tokens: 4 }
      if (body.stream !== true)
        return c.json({
          id,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        })
      return new Response(
        sse([
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id,
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 12, output_tokens: 1 },
              },
            },
          ],
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 4 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      )
    })
  },
})

export const startMessagesEmulator = async (
  accounts: Record<string, AccountBehavior>,
  opts: { port?: number } = {},
) => {
  const seeded = Object.fromEntries(
    Object.entries(accounts).map(([k, v]) => [k, { ...v, used: 0 }]),
  )
  const api = await createEmulator({
    service: messages,
    port: opts.port ?? 0,
    seed: { accounts: seeded, requests: [] },
  })
  const snap = () => api.snapshot().state as MessagesState
  return { url: api.url, requests: () => snap().requests, close: () => api.close() }
}
