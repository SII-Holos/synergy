import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"

/**
 * Single authoritative "is this machine working" predicate for the whole
 * runtime. Desktop's keep-awake guard polls this instead of deriving its own
 * rule from per-scope `session.status` events, which cannot see scopes the UI
 * never loaded and cannot see detached background work at all.
 */
const GlobalActivity = z
  .object({
    active: z.boolean(),
    sessions: z.number().int().nonnegative(),
    backgroundJobs: z.number().int().nonnegative(),
  })
  .meta({ ref: "GlobalActivity" })

export const GlobalActivityRoute = new Hono().get(
  "/",
  describeRoute({
    summary: "Get global activity",
    description:
      "Report whether any session or background job is currently working, across every scope. Non-idle session statuses (busy, retry, recovering) and in-flight loop background jobs both count. Read-only and served from memory; clients that must not let the machine idle poll this endpoint.",
    operationId: "global.activity",
    responses: {
      200: {
        description: "Global activity snapshot",
        content: {
          "application/json": {
            schema: resolver(GlobalActivity),
          },
        },
      },
    },
  }),
  async (c) => {
    const sessions = Object.keys(await SessionManager.listStatuses()).length
    const backgroundJobs = LoopJob.activeBackgroundCount()
    c.header("Cache-Control", "no-store")
    return c.json({ active: sessions > 0 || backgroundJobs > 0, sessions, backgroundJobs })
  },
)
