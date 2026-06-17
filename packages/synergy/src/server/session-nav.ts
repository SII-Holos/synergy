import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { SessionNav, NavCategory, SessionNavResponse } from "../session/nav"
import { Instance } from "../scope/instance"

const booleanQuery = z.enum(["true", "false"]).transform((v) => v === "true")

const SessionNavQuery = z
  .object({
    category: NavCategory.optional(),
    parentOnly: booleanQuery.optional(),
    includeArchived: booleanQuery.optional().default(false),
    limit: z.coerce.number().int().min(1).max(200).optional().default(20),
    cursorLastActivityAt: z.coerce.number().optional(),
    cursorId: z.string().optional(),
  })
  .transform((v) => {
    const parentOnly = v.category !== undefined ? false : (v.parentOnly ?? true)
    const cursor: { lastActivityAt: number; id: string } | undefined =
      v.cursorLastActivityAt !== undefined && v.cursorId !== undefined
        ? { lastActivityAt: v.cursorLastActivityAt, id: v.cursorId }
        : undefined
    return { ...v, parentOnly, cursor }
  })

export const SessionNavRoute = new Hono().get(
  "/index",
  describeRoute({
    summary: "List session navigation entries",
    description: "Get paginated session navigation entries for the current scope with filtering and cursor support.",
    operationId: "session.index",
    responses: {
      200: {
        description: "Paginated session navigation entries",
        content: {
          "application/json": {
            schema: resolver(SessionNavResponse),
          },
        },
      },
    },
  }),
  validator("query", SessionNavQuery),
  async (c) => {
    const query = c.req.valid("query")
    const result = await SessionNav.queryScope(Instance.scope.id, {
      parentOnly: query.parentOnly,
      category: query.category,
      includeArchived: query.includeArchived,
      cursor: query.cursor,
      limit: query.limit,
    })
    return c.json(result)
  },
)
