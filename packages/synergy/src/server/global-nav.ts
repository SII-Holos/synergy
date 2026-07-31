import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { NavCategory, SessionNav, SessionNavResponse, SessionNavEntry } from "../session/nav"
import { Session } from "../session"

const booleanQuery = z.preprocess((value) => (value === "false" ? false : value), z.coerce.boolean())

const GlobalRecentResponse = SessionNavResponse.extend({
  unreadCompletionCount: z.number().int().nonnegative(),
}).meta({ ref: "GlobalRecentResponse" })

const GlobalAcknowledgeCompletionsResponse = z
  .object({
    acknowledgedCount: z.number().int().nonnegative(),
    modifiedSessionCount: z.number().int().nonnegative(),
    failedSessionCount: z.number().int().nonnegative(),
  })
  .meta({ ref: "GlobalAcknowledgeCompletionsResponse" })

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
        parentOnly: booleanQuery.optional().default(true),
        includeArchived: booleanQuery.optional().default(false),
        category: NavCategory.optional(),
        channelType: z.string().min(1).optional(),
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
        category: q.category,
        channelType: q.channelType,
        search: q.search,
        cursor,
        limit: q.limit,
      })
      return c.json(result)
    },
  )
  .post(
    "/acknowledge-completions",
    describeRoute({
      summary: "Acknowledge completion notices across all scopes",
      description: "Acknowledge completion notices for non-archived root sessions across all scopes.",
      operationId: "global.nav.acknowledgeCompletions",
      responses: {
        200: {
          description: "Completion notices acknowledged",
          content: {
            "application/json": {
              schema: resolver(GlobalAcknowledgeCompletionsResponse),
            },
          },
        },
      },
    }),
    async (c) => c.json(await Session.batchAcknowledgeCompletionNotices()),
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
