import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { EngramStatsEngine } from "@/engram"
import { EngramStatsSnapshot } from "@/engram/stats/types"

const EngramStatsQuery = z.object({
  recompute: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .meta({ description: "Set to 'true' to force a full recompute from scratch" }),
})

export const EngramStatsRoute = new Hono().get(
  "/",
  describeRoute({
    summary: "Get engram stats snapshot",
    description:
      "Get the full engram (memory & experience) stats snapshot. Returns cached snapshot if available, otherwise computes. Use ?recompute=true to force a fresh compute.",
    operationId: "engram.stats.get",
    responses: {
      200: {
        description: "Engram stats snapshot",
        content: {
          "application/json": {
            schema: resolver(EngramStatsSnapshot.meta({ ref: "EngramStatsSnapshot" })),
          },
        },
      },
      ...errors(400),
    },
  }),
  validator("query", EngramStatsQuery),
  async (c) => {
    const { recompute } = c.req.valid("query")
    try {
      const snapshot = recompute === "true" ? await EngramStatsEngine.recompute() : await EngramStatsEngine.get()
      return c.json(snapshot)
    } catch (err: any) {
      return c.json({ message: err?.message ?? String(err) }, 400)
    }
  },
)
