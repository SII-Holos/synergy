import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../config/config"
import { getSandboxReadiness } from "../sandbox/readiness"

const SandboxReadinessCheckSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
    recovery: z
      .object({
        action: z.string(),
        label: z.string(),
        command: z.string(),
      })
      .optional(),
  })
  .meta({ ref: "SandboxReadinessCheck" })

const SandboxReadinessSchema = z
  .object({
    platform: z.enum(["macos", "linux", "windows", "unsupported"]),
    backend: z.string().nullable(),
    ready: z.boolean(),
    checks: z.array(SandboxReadinessCheckSchema),
    summary: z.string(),
  })
  .meta({ ref: "SandboxReadiness" })

export const SandboxReadinessRoute = new Hono().get(
  "/sandbox/readiness",
  describeRoute({
    summary: "Get sandbox readiness",
    description:
      "Platform-specific sandbox health checks. Returns readiness status with per-check diagnostics for macOS, Linux, and Windows.",
    operationId: "sandbox.readiness",
    responses: {
      200: {
        description: "Sandbox readiness information",
        content: {
          "application/json": {
            schema: resolver(SandboxReadinessSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const cfg = await Config.get()
    const readiness = await getSandboxReadiness(cfg.sandbox)
    return c.json(readiness)
  },
)
