import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Diagnostics } from "@/observability/diagnostics"

export const ObservabilityRoute = new Hono().get(
  "/diagnostics",
  describeRoute({
    summary: "Get local diagnostics summary",
    description: "Get a readonly local diagnostics summary for the Synergy server.",
    operationId: "observability.diagnostics.summary",
    responses: {
      200: {
        description: "Diagnostics summary",
        content: {
          "application/json": {
            schema: resolver(z.record(z.string(), z.any()).meta({ ref: "DiagnosticsSummary" })),
          },
        },
      },
    },
  }),
  async (c) => c.json(await Diagnostics.summary()),
)
