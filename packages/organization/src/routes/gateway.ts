import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationGatewayProtocol as Gateway,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { operation, validation } from "./shared"
import { fail } from "../error"
import type { GatewayCalls } from "../gateway-calls"
import type { ConnectionGateway, ModelGateway } from "../gateway"

export function gatewayRoutes(
  gateway: () => { calls: GatewayCalls; models: ModelGateway; connections: ConnectionGateway },
) {
  const app = new Hono()
  app.use("/gateway/*", async (c, next) => {
    if (c.req.header("origin") || c.req.header("cookie"))
      fail("PERMISSION_DENIED", "Gateway access requires a machine capability")
    await next()
  })
  app.post(
    "/gateway/calls",
    operation("orgGateway.reserve", "Reserve one finite root resource call", Gateway.SignedPermit, true),
    validator("json", Gateway.Request, validation),
    async (c) => c.json(await gateway().calls.reserve(c.req.valid("json"))),
  )
  app.post(
    "/gateway/calls/inspect",
    operation("orgGateway.inspect", "Inspect a resource call without dispatching it", Gateway.Receipt, true),
    validator("json", Gateway.Request, validation),
    async (c) => c.json(await gateway().calls.inspect(c.req.valid("json"))),
  )
  app.post(
    "/gateway/connections/:resourceID",
    describeRoute({
      operationId: "orgGateway.connection",
      summary: "Forward one fixed business connection request using server-owned credentials",
      requestBody: {
        required: false,
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      responses: {
        200: {
          description: "Business connection response; supported streams preserve upstream bytes",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.unknown())) },
            "text/event-stream": { schema: { type: "string" } },
            "application/octet-stream": { schema: { type: "string", format: "binary" } },
          },
        },
        ...Object.fromEntries(
          [400, 401, 403, 409, 503].map((status) => [
            status,
            {
              description: "Organization error before or during business forwarding",
              content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
            },
          ]),
        ),
      },
    }),
    async (c) => gateway().connections.invoke(c.req.raw, c.req.param("resourceID")),
  )
  app.post(
    "/gateway/connections/:resourceID/mcp",
    describeRoute({
      operationId: "orgGateway.mcp",
      summary: "Invoke one admitted remote MCP operation using server-owned credentials",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      responses: {
        200: {
          description: "Validated MCP list or tool result",
          content: { "application/json": { schema: resolver(Gateway.McpResult) } },
        },
        ...Object.fromEntries(
          [400, 401, 403, 409, 503].map((status) => [
            status,
            {
              description: "Organization error before or during MCP forwarding",
              content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
            },
          ]),
        ),
      },
    }),
    validator("json", Gateway.McpRequest, validation),
    async (c) =>
      gateway().connections.invokeMcp(
        new Request(c.req.raw.url, {
          method: c.req.raw.method,
          headers: c.req.raw.headers,
          body: JSON.stringify(c.req.valid("json")),
          signal: c.req.raw.signal,
        }),
        c.req.param("resourceID"),
      ),
  )
  for (const [path, protocol, id] of [
    ["chat/completions", "openai-compatible", "orgGateway.chatCompletions"],
    ["messages", "anthropic-compatible", "orgGateway.messages"],
  ] as const) {
    app.post(
      `/gateway/models/:resourceID/${path}`,
      describeRoute({
        operationId: id,
        summary: "Forward one admitted model request using server-owned credentials",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: {
          200: {
            description: "Model protocol response; streams preserve upstream bytes",
            content: {
              "application/json": { schema: resolver(z.record(z.string(), z.unknown())) },
              "text/event-stream": { schema: { type: "string" } },
            },
          },
          ...Object.fromEntries(
            [400, 401, 403, 409, 503].map((status) => [
              status,
              {
                description: "Organization error before streaming",
                content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
              },
            ]),
          ),
        },
      }),
      async (c) => gateway().models.invoke(c.req.raw, c.req.param("resourceID"), protocol),
    )
  }
  return app
}
