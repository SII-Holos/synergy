import { MCP } from "."
import { McpRoute } from "./routes/mcp-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { resolver } from "hono-openapi"
import { z } from "zod"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: {
        "scoped-integrations": new Hono().route("/mcp", McpRoute()).get(
          "/experimental/resource",
          describeRoute({
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
            operationId: "experimental.resource.list",
            responses: {
              200: {
                description: "MCP resources",
                content: {
                  "application/json": {
                    schema: resolver(z.record(z.string(), MCP.Resource)),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await MCP.resources())
          },
        ),
      },
      bootstrap: { mcp: { schema: z.record(z.string(), MCP.Status), load: () => MCP.status() } },
    },
    "mcp",
  )
}
