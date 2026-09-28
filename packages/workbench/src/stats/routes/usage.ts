import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { Usage, UsageSchema } from "@ericsanchezok/synergy-harness/usage"
import { errors } from "@ericsanchezok/synergy-server/server/error"

const Query = UsageSchema.Filter.extend({
  includeDescendants: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  from: z.coerce.number().int().nonnegative().safe().optional(),
  to: z.coerce.number().int().nonnegative().safe().optional(),
})
const PageQuery = Query.extend({
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
const Clear = z.object({ scope: UsageSchema.Filter, throughRevision: z.number().int().nonnegative() }).strict()
const Cleared = z.object({
  removed: z.number(),
  activeRetained: z.number(),
  newerRetained: z.number(),
  unattributedRetained: z.number().describe("Owner-level gaps retained because the clear selects a specific run"),
  revision: z.number(),
})
const response = (schema: z.ZodType, description: string) => ({
  200: { description, content: { "application/json": { schema: resolver(schema) } } },
  ...errors(400),
})

export const UsageRoute = () =>
  new Hono()
    .get(
      "/",
      describeRoute({
        operationId: "global.stats.usage",
        summary: "Get canonical usage statistics",
        description:
          "Read retained usage facts with explicit unknowns, billing bases, transport timing, attribution and migration coverage. Time ranges are half-open; request days use the sent timestamp in the returned timezone.",
        responses: response(Usage.Summary, "Canonical usage summary"),
      }),
      validator("query", Query),
      async (c) => {
        try {
          return c.json(await Usage.summary(c.req.valid("query")))
        } catch (error) {
          if (UsageSchema.InvalidQuery.isInstance(error)) return c.json({ message: error.data.message }, 400)
          throw error
        }
      },
    )
    .get(
      "/records",
      describeRoute({
        operationId: "global.stats.usageRecords",
        summary: "Page through retained usage records",
        description:
          "Read compact records without prompts, tool arguments or raw response content. Cursor filters must match the initial request. Each record has a revision; reconnect through the summary endpoint.",
        responses: response(Usage.Page, "Usage records"),
      }),
      validator("query", PageQuery),
      async (c) => {
        const { cursor, limit, ...scope } = c.req.valid("query")
        try {
          return c.json(await Usage.records(scope, { cursor, limit }))
        } catch (error) {
          if (UsageSchema.InvalidQuery.isInstance(error)) return c.json({ message: error.data.message }, 400)
          throw error
        }
      },
    )
    .post(
      "/rebuild",
      describeRoute({
        operationId: "global.stats.usageRebuild",
        summary: "Schedule or resume historical usage capture",
        description:
          "Returns the durable background job. Rebuilding preserves existing facts, original pricing and explicit deletion markers.",
        responses: response(UsageSchema.Rebuild, "Durable rebuild job"),
      }),
      async (c) => c.json(await Usage.rebuild()),
    )
    .delete(
      "/records",
      describeRoute({
        operationId: "global.stats.usageClear",
        summary: "Clear explicitly scoped terminal usage records",
        description:
          "Requires an explicit Scope, session or time range and the summary revision to clear through. Active and newer records are retained. Run-filtered clears also retain unattributed owner-level gaps. Cleared identities cannot be restored by a rebuild.",
        responses: response(Cleared, "Cleared and retained record counts"),
      }),
      validator("json", Clear),
      async (c) => {
        const { scope, throughRevision } = c.req.valid("json")
        try {
          return c.json(await Usage.clear(scope, throughRevision))
        } catch (error) {
          if (UsageSchema.InvalidQuery.isInstance(error)) return c.json({ message: error.data.message }, 400)
          throw error
        }
      },
    )
