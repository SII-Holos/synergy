import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { Engine } from "@/stats"
import { ProgressEvent, StatsSnapshot } from "@/stats/types"

const StatsQuery = z.object({
  recompute: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .meta({ description: "Set to 'true' to force a full recompute from scratch" }),
})

export const StatsRoute = new Hono()
  .get(
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
    validator("query", StatsQuery),
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
  .get(
    "/progress",
    describeRoute({
      summary: "Stream stats recompute progress",
      description: "Force a stats recompute and stream progress updates over SSE until the final snapshot is ready.",
      operationId: "stats.progress",
      responses: {
        200: {
          description: "Server-sent events containing progress and final snapshot payloads",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.object({
                  type: z.enum(["progress", "done", "error"]),
                  progress: ProgressEvent.optional(),
                  snapshot: StatsSnapshot.optional(),
                  message: z.string().optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      c.header("X-Accel-Buffering", "no")
      c.header("Cache-Control", "no-cache, no-transform")
      return streamSSE(c, async (stream) => {
        try {
          const snapshot = await Engine.recompute(async (event) => {
            await stream.writeSSE({
              data: JSON.stringify({
                type: "progress",
                progress: event,
              }),
            })
          })
          await stream.writeSSE({
            data: JSON.stringify({
              type: "done",
              snapshot,
            }),
          })
        } catch (err: any) {
          await stream.writeSSE({
            data: JSON.stringify({
              type: "error",
              message: err?.message ?? String(err),
            }),
          })
        } finally {
          stream.close()
        }
      })
    },
  )
