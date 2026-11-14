import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { OrganizationProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationServiceMaintenance } from "./service-maintenance"

const paths = { live: "/org/v1/live", ready: "/org/v1/ready", get: "/org/v1/health" } as const

export namespace OrganizationHealth {
  export function kind(request: Request) {
    if (request.method !== "GET" && request.method !== "HEAD") return
    const pathname = new URL(request.url).pathname
    return (Object.keys(paths) as Array<keyof typeof paths>).find((name) => paths[name] === pathname)
  }
  export async function response(request: Request, alive: () => boolean) {
    const selected = kind(request)
    if (!selected) throw new Error("Organization health requires its exact read-only probe")
    const available =
      selected === "live" ? alive() : alive() && (await OrganizationServiceMaintenance.ready()) && alive()
    const body =
      selected === "live"
        ? { alive: available, protocolVersion: Protocol.version }
        : { ready: available, protocolVersion: Protocol.version }
    return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
      status: available ? 200 : 503,
      headers: { "content-type": "application/json" },
    })
  }
  export function routes(ready: () => boolean) {
    const app = new Hono()
    for (const name of Object.keys(paths) as Array<keyof typeof paths>) {
      const schema = name === "live" ? Protocol.Liveness : Protocol.Health
      app.get(
        paths[name],
        describeRoute({
          operationId: `orgHealth.${name}`,
          summary:
            name === "live" ? "Read process liveness without storage admission" : "Read organization service readiness",
          responses: {
            200: { description: "Available", content: { "application/json": { schema: resolver(schema) } } },
            503: { description: "Unavailable", content: { "application/json": { schema: resolver(schema) } } },
          },
        }),
        async (c) => {
          const result = await response(c.req.raw, ready)
          return c.newResponse(result.body, result)
        },
      )
    }
    return app
  }
}
