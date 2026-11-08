import { Hono } from "hono"
import { describeRoute, generateSpecs, resolver } from "hono-openapi"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"

export function organizationOpenApi() {
  return generateSpecs(
    organizationApp(() => false),
    {
      documentation: {
        info: { title: "Synergy Organization API", version: String(OrganizationProtocol.version) },
      },
    },
  )
}

export function organizationApp(ready: () => boolean) {
  return new Hono().get(
    "/org/v1/health",
    describeRoute({
      operationId: "orgHealth.get",
      summary: "Read organization service readiness",
      responses: {
        200: {
          description: "Ready",
          content: { "application/json": { schema: resolver(OrganizationProtocol.Health) } },
        },
        503: {
          description: "Not ready",
          content: { "application/json": { schema: resolver(OrganizationProtocol.Health) } },
        },
      },
    }),
    (c) => c.json({ ready: ready(), protocolVersion: OrganizationProtocol.version }, ready() ? 200 : 503),
  )
}
