import { env } from "@packages/env/api-hono"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import {
  CHECK_STATUSES,
  defaultRunner,
  GIT_SOURCES,
  OTHER_SKILL_KINDS,
  type Runner,
  workspaceNameError,
} from "inscope"
import { z } from "zod"

import {
  ApiError,
  errorHandler,
  forbiddenErrorResponses,
  inscopeConfigErrorResponses,
  notFoundErrorResponses,
  validationErrorResponses,
} from "@/lib/error"
import {
  diff,
  doctor,
  findWorkspaceOrThrow,
  MCP_STATES,
  overview,
  readConfig,
  status,
  workspaceDetail,
} from "@/lib/inscope"
// not the barrel: it also loads the auth middleware, which starts better-auth, and the dashboard reads nothing behind a session
import { requireLocal } from "@/middlewares/local"

const skillsSchema = z.object({
  dir: z.string().meta({ example: "~/work/.inscope/skills" }),
  other: z.array(
    z.object({
      kind: z.enum(OTHER_SKILL_KINDS),
      label: z.string().meta({ example: "yours" }),
      name: z.string().meta({ example: "my-notes" }),
      target: z.string().nullable(),
      workspace: z.string().nullable(),
    }),
  ),
  own: z.array(
    z.object({
      linked: z.boolean(),
      name: z.string().meta({ example: "inscope" }),
      source: z.string().nullable().meta({ example: "owner/repo#skills/readme-audit" }),
    }),
  ),
})

const workspaceSchema = z.object({
  gh: z.string().nullable().meta({ example: "neeraj-work" }),
  git: z.object({ email: z.string().nullable(), name: z.string().nullable() }),
  isolated: z.boolean(),
  mcp: z.object({
    error: z.string().nullable(),
    path: z.string().meta({ example: "~/work/.mcp.json" }),
    servers: z.array(
      z.object({
        managed: z.boolean(),
        name: z.string().meta({ example: "github-work" }),
        written: z.boolean(),
      }),
    ),
    state: z.enum(MCP_STATES),
    types: z.array(z.string()).meta({ example: ["github", "linear"] }),
  }),
  name: z.string().meta({ example: "work" }),
  path: z.string().meta({ example: "~/work" }),
  skills: skillsSchema,
})

const identitySchema = z.object({
  claude: z.object({
    configDir: z.string().meta({ example: "~/work/.inscope" }),
    email: z.string().nullable(),
    isolated: z.boolean(),
    org: z.string().nullable(),
    signedIn: z.boolean(),
    subscription: z.string().nullable().meta({ example: "team" }),
  }),
  git: z.object({ email: z.string().nullable(), source: z.enum(GIT_SOURCES) }),
  github: z.object({ account: z.string(), token: z.boolean() }).nullable(),
  name: z.string().meta({ example: "work" }),
})

const checkSchema = z.object({
  detail: z.string().nullable(),
  label: z.string().meta({ example: "[work] mcp" }),
  status: z.enum(CHECK_STATUSES),
})

const driftSchema = z.object({
  diff: z.string().nullable(),
  error: z.string().nullable(),
  label: z.string().meta({ example: "mcp:work" }),
  path: z.string().meta({ example: "~/work/.mcp.json" }),
})

// One documented GET: its { data } schema, plus the gate's 403 and the 422 every route returns for an invalid config.
const documentedGet = (description: string, client: string, data: z.ZodType, extra = {}) =>
  describeRoute({
    tags: ["inscope"],
    description,
    ...({
      "x-codeSamples": [
        {
          lang: "typescript",
          label: "hono/client",
          source: `import { apiClient, unwrap } from "@/lib/api/client"

const { data, error } = await unwrap(${client})`,
        },
      ],
    } as object),
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: resolver(z.object({ data })) } },
      },
      ...forbiddenErrorResponses,
      ...inscopeConfigErrorResponses,
      ...extra,
    },
  })

type InscopeRouterOptions = {
  peer?: Parameters<typeof requireLocal>[0]["peer"]
  run?: Runner
  stage?: string
  trustedOrigins?: string[]
}

// The read-only inscope dashboard API: this machine's ~/.config/inscope, answered only on the local stage and only to loopback (see requireLocal). Options exist so tests can pin the stage, the socket peer, and the commands it runs.
export const createInscopeRouter = ({
  peer,
  run = defaultRunner,
  stage = env.NODE_ENV,
  trustedOrigins = env.HONO_TRUSTED_ORIGINS,
}: InscopeRouterOptions = {}) =>
  new Hono()
    // its own handler, so the { error } envelope holds when the router is exercised on its own as well as mounted
    .onError(errorHandler)
    // ahead of the gate, so its 403 and 404 are never cached either
    .use(async (c, next) => {
      await next()
      c.header("Cache-Control", "no-store")
    })
    .use(requireLocal({ peer, stage, trustedOrigins }))
    .get(
      "/",
      documentedGet(
        "Every workspace in the inscope config, with its MCP file and skill links as they are on disk. Reads files only.",
        "apiClient.inscope.$get()",
        z.object({
          workspaces: z.array(workspaceSchema),
          config: z.object({
            bypass: z.boolean(),
            exists: z.boolean(),
            path: z.string().meta({ example: "~/.config/inscope/inscope.json" }),
          }),
        }),
      ),
      (c) => c.json({ data: overview(readConfig()) }),
    )
    .get(
      "/diff",
      documentedGet(
        "What `inscope apply` would change, with credential values redacted, and what `inscope diff --adopt` would pull back into the config.",
        "apiClient.inscope.diff.$get()",
        z.object({ drifts: z.array(driftSchema), adoptable: z.array(z.string()) }),
      ),
      (c) => c.json({ data: diff(readConfig()) }),
    )
    .get(
      "/doctor",
      documentedGet(
        "The checks `inscope doctor` runs, without its section about the calling shell.",
        "apiClient.inscope.doctor.$get()",
        z.object({
          checks: z.array(checkSchema),
          summary: z.object({ fail: z.number(), ok: z.number(), warn: z.number() }),
        }),
      ),
      (c) => c.json({ data: doctor(readConfig(), run) }),
    )
    .get(
      "/status",
      documentedGet(
        "The identity each workspace resolves to: its Claude login, GitHub account (token presence only), and git email.",
        "apiClient.inscope.status.$get()",
        z.object({ workspaces: z.array(identitySchema) }),
      ),
      (c) => c.json({ data: status(readConfig(), run) }),
    )
    .get(
      "/workspaces/:name",
      documentedGet(
        "One workspace: its summary, the identity it resolves to, and the doctor checks and pending changes that belong to it.",
        'apiClient.inscope.workspaces[":name"].$get({ param: { name: "work" } })',
        z.object({
          workspace: workspaceSchema,
          checks: z.array(checkSchema),
          drifts: z.array(driftSchema),
          identity: identitySchema,
        }),
        { ...notFoundErrorResponses, ...validationErrorResponses },
      ),
      (c) => {
        const name = c.req.param("name")
        const nameErr = workspaceNameError(name)
        if (nameErr)
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            `workspace name "${name}" is invalid: ${nameErr}`,
          )
        const { cfg, ws } = findWorkspaceOrThrow(readConfig(), name)
        return c.json({ data: workspaceDetail(cfg, ws, run) })
      },
    )

export const inscopeRouter = createInscopeRouter()
