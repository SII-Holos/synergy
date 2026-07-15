import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { SessionNav, SessionNavResponse, SessionNavEntry } from "../session/nav"

const GlobalRecentResponse = SessionNavResponse.extend({
  unreadCompletionCount: z.number().int().nonnegative(),
}).meta({ ref: "GlobalRecentResponse" })

const PinnedResponse = z
  .object({
    items: SessionNavEntry.array(),
    total: z.number(),
  })
  .meta({ ref: "PinnedResponse" })

export const GlobalNavRoute = new Hono()
  .get(
    "/recent",
    describeRoute({
      summary: "Recent sessions across all scopes",
      description: "Get a paginated list of recently active sessions across all scopes (global + projects).",
      operationId: "global.nav.recent",
      responses: {
        200: {
          description: "Paginated recent sessions",
          content: {
            "application/json": {
              schema: resolver(GlobalRecentResponse),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        parentOnly: z.coerce.boolean().optional().default(true),
        includeArchived: z.coerce.boolean().optional().default(false),
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional().default(20),
        cursorLastActivityAt: z.coerce.number().optional(),
        cursorId: z.string().optional(),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query")
      const cursor =
        q.cursorLastActivityAt !== undefined && q.cursorId !== undefined
          ? { lastActivityAt: q.cursorLastActivityAt, id: q.cursorId }
          : undefined

      const result = await SessionNav.queryGlobal({
        parentOnly: q.parentOnly,
        includeArchived: q.includeArchived,
        search: q.search,
        cursor,
        limit: q.limit,
      })
      return c.json(result)
    },
  )
  .get(
    "/pinned",
    describeRoute({
      summary: "Pinned sessions across all scopes",
      description: "Get a list of pinned sessions across all scopes (global + projects), sorted by recent activity.",
      operationId: "global.nav.pinned",
      responses: {
        200: {
          description: "Pinned sessions",
          content: {
            "application/json": {
              schema: resolver(PinnedResponse),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query")
      const result = await SessionNav.queryPinned({ limit: q.limit })
      return c.json(result)
    },
  )
