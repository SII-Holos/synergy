import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"

export const GitHubConfiguredResponse = z
  .object({
    configured: z.boolean(),
  })
  .meta({ ref: "GitHubConfiguredResponse" })

export const GitHubConfiguredRoute = new Hono().get(
  "/configured",
  describeRoute({
    summary: "Check whether the GitHub App is configured",
    description: "Reports whether both required GitHub App environment variables are present without exposing them.",
    operationId: "github.configured",
    responses: {
      200: {
        description: "GitHub App configuration status",
        content: {
          "application/json": {
            schema: resolver(GitHubConfiguredResponse),
          },
        },
      },
    },
  }),
  (c) => {
    const configured = Boolean(
      process.env.SYNERGY_GITHUB_APP_ID?.trim() && process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY?.trim(),
    )
    return c.json({ configured })
  },
)
