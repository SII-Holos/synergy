import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { Diagnostics } from "@/observability/diagnostics"
import { ObservabilitySchema } from "@/observability/schema"

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
            schema: resolver(ObservabilitySchema.DiagnosticsSummary),
          },
        },
      },
    },
  }),
  async (c) => c.json(await Diagnostics.summary()),
)
