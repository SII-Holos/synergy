import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { Engine } from "@/stats"
import { StatsSnapshot } from "@/stats/types"

export const StatsRoute = new Hono().get(
  "/",
  describeRoute({
    summary: "Get stats snapshot",
    description:
      "Get the full stats snapshot. Returns cached snapshot if available, otherwise computes incrementally. Use ?recompute=true to force a full recompute from scratch.",
    operationId: "stats.get",
    responses: {
      200: {
        description: "Stats snapshot",
        content: {
          "application/json": {
            schema: resolver(StatsSnapshot.meta({ ref: "StatsSnapshot" })),
          },
        },
      },
      ...errors(400),
    },
  }),
  validator(
    "query",
    z.object({
      recompute: z
        .enum(["true", "false"])
        .optional()
        .default("false")
        .meta({ description: "Set to 'true' to force full recompute from scratch" }),
    }),
  ),
  async (c) => {
    const { recompute } = c.req.valid("query")
    try {
      const snapshot = recompute === "true" ? await Engine.recompute() : await Engine.get()
      return c.json(snapshot)
    } catch (err: any) {
      return c.json({ message: err?.message ?? String(err) }, 400)
    }
  },
)
