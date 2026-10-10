import { createEmulator, defineEmulator } from "emulate"

// A stateful stand-in for Anthropic's subscription usage endpoint (the undocumented
// GET /api/oauth/usage behind Claude Code's /usage), built on vercel-labs/emulate's
// custom-emulator API since emulate ships no Anthropic service. Each access token
// maps to a behavior, so one emulator serves a live login, an expired one, a rate
// limit, a server error, and a response whose shape drifted. The real response
// (captured 2026-10-10) carries `five_hour`/`seven_day` objects with `utilization`
// (percent) and `resets_at` (ISO), plus many nullable extras; the emulator returns the
// same shape so the parser is tested against what the endpoint actually sends. It also
// answers GET /api/oauth/profile (behind Claude Code's account view) with the
// `organization` fields inscope reads the plan from, in the shape captured 2026-10-10.
export type TokenBehavior =
  | {
      kind: "ok"
      fiveHour: number
      week: number
      fiveHourResets: string
      weekResets: string
      // The organization's rate-limit tier the profile endpoint reports.
      tier?: string
    }
  | { kind: "status"; status: number }
  | { kind: "shape"; body: unknown }

export type AnthropicState = {
  tokens: Record<string, TokenBehavior>
  requests: { path: string; authorization: string | null; beta: string | null }[]
}

const anthropic = defineEmulator<AnthropicState>({
  name: "anthropic-oauth",
  state: () => ({ tokens: {}, requests: [] }),
  setup({ app, state }) {
    app.get("/api/oauth/profile", (c) => {
      const authorization = c.req.header("authorization") ?? null
      state.requests.push({
        path: "/api/oauth/profile",
        authorization,
        beta: c.req.header("anthropic-beta") ?? null,
      })
      const behavior = authorization?.startsWith("Bearer ")
        ? state.tokens[authorization.slice("Bearer ".length)]
        : undefined
      if (behavior?.kind !== "ok")
        return c.json({ type: "error", error: { type: "authentication_error" } }, 401)
      return c.json({
        account: { uuid: "u", email: "x@x.dev", has_claude_max: true, has_claude_pro: false },
        organization: {
          uuid: "o",
          organization_type: behavior.tier?.includes("max") ? "claude_max" : "claude_pro",
          billing_type: "stripe_subscription",
          rate_limit_tier: behavior.tier ?? null,
          subscription_status: "active",
        },
      })
    })
    app.get("/api/oauth/usage", (c) => {
      const authorization = c.req.header("authorization") ?? null
      const beta = c.req.header("anthropic-beta") ?? null
      state.requests.push({ path: "/api/oauth/usage", authorization, beta })
      if (!authorization?.startsWith("Bearer "))
        return c.json(
          {
            type: "error",
            error: { type: "authentication_error", message: "x-api-key header is required" },
          },
          401,
        )
      if (beta !== "oauth-2025-04-20")
        return c.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: "OAuth beta required" },
          },
          400,
        )
      const behavior = state.tokens[authorization.slice("Bearer ".length)]
      if (!behavior)
        return c.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "OAuth access token has expired. Re-authenticate to continue.",
            },
          },
          401,
        )
      if (behavior.kind === "status")
        return c.json(
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
          behavior.status as 429,
        )
      if (behavior.kind === "shape") return c.json(behavior.body as Record<string, unknown>)
      const window = (utilization: number, resets_at: string) => ({
        utilization,
        resets_at,
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
        locked_reason: null,
      })
      return c.json({
        five_hour: window(behavior.fiveHour, behavior.fiveHourResets),
        seven_day: window(behavior.week, behavior.weekResets),
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        extra_usage: { is_enabled: false, monthly_limit: null },
        limits: [
          { kind: "session", group: "session", percent: behavior.fiveHour, severity: "normal" },
        ],
      })
    })
  },
})

export const startAnthropicEmulator = async (tokens: Record<string, TokenBehavior>) => {
  const api = await createEmulator({
    service: anthropic,
    port: 0,
    seed: { tokens, requests: [] },
  })
  return {
    url: api.url,
    requests: () => (api.snapshot().state as AnthropicState).requests,
    close: () => api.close(),
  }
}
