import { Hono } from "hono"
import { describeRoute, generateSpecs, resolver } from "hono-openapi"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { type Authentication } from "./auth"
import { identityRoutes } from "./routes/identity"
import { OrganizationError, errorStatus, fail } from "./error"
import type { RuntimeRegistrations } from "./runtime-registration"
import { registrationRoutes, machineRegistrationRoutes } from "./routes/runtime-registration"
import type { RuntimeConnections } from "./runtime-connection"
import { runtimeConnectionRoutes, type RuntimeBindings } from "./routes/runtime-connection"
import { ClientPolicy } from "./auth/client-policy"
import type { ClientAuthentication } from "./auth/client"
import { clientAuthenticationRoutes } from "./routes/client-auth"
import { sessionDirectoryRoutes } from "./routes/session-directory"
import { commandRoutes } from "./routes/commands"
import { resourceRoutes } from "./routes/resources"
import { executionRoutes } from "./routes/execution"
import type { ExecutionGrants } from "./execution-grants"
import type { CommandForwarder } from "./command-forwarding"

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

export function organizationApp(
  ready: () => boolean,
  authentication?: Authentication,
  publicOrigin?: string,
  registrations?: RuntimeRegistrations,
  connections?: RuntimeConnections,
  clientAuthentication?: ClientAuthentication,
  commands?: CommandForwarder,
  execution?: ExecutionGrants,
) {
  function registry() {
    if (!registrations) fail("SERVICE_UNAVAILABLE", "Runtime registration is unavailable")
    return registrations
  }
  return new Hono<{ Variables: { requestID: string }; Bindings: RuntimeBindings }>()
    .use("*", async (c, next) => {
      const requestID = crypto.randomUUID()
      c.set("requestID", requestID)
      c.header("X-Request-ID", requestID)
      c.header("Cache-Control", "no-store")
      c.header("Referrer-Policy", "no-referrer")
      c.header("X-Content-Type-Options", "nosniff")
      const origin = c.req.header("origin")
      if (origin && origin !== publicOrigin) {
        c.header("Vary", "Origin")
        if (!ClientPolicy.allowsOrigin(origin)) fail("PERMISSION_DENIED", "The request origin is not allowed")
        c.header("Access-Control-Allow-Origin", origin)
        c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
        c.header("Access-Control-Allow-Headers", "Authorization,Content-Type")
        if (c.req.method === "OPTIONS") return c.body(null, 204)
      }
      await next()
    })
    .use("*", bodyLimit({ maxSize: 64 * 1024, onError: () => fail("INVALID_REQUEST", "Request body is too large") }))
    .onError((error, c) => {
      if (error instanceof OrganizationError)
        return c.json(
          { ...error.data, requestID: error.data.requestID ?? c.get("requestID") },
          errorStatus(error.data.code),
        )
      if (error instanceof z.ZodError || (error instanceof HTTPException && error.status === 400)) {
        return c.json(
          {
            code: "INVALID_REQUEST",
            message: "Invalid request",
            requestID: c.get("requestID"),
            outcome: "not_dispatched",
            retryable: false,
          },
          400,
        )
      }
      return c.json(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "The organization service could not complete this request",
          requestID: c.get("requestID"),
          outcome: "unknown",
          retryable: false,
        },
        503,
      )
    })
    .route(
      "/org/v1",
      identityRoutes(() => {
        if (!authentication) fail("SERVICE_UNAVAILABLE", "Authentication is unavailable")
        return authentication
      }, publicOrigin),
    )
    .route("/org/v1", registrationRoutes(registry, publicOrigin))
    .route("/org/v1", sessionDirectoryRoutes(publicOrigin))
    .route("/org/v1", resourceRoutes(publicOrigin))
    .route(
      "/org/v1",
      commandRoutes(() => {
        if (!commands) fail("SERVICE_UNAVAILABLE", "Command forwarding is unavailable")
        return commands
      }, publicOrigin),
    )
    .route(
      "/org/v1",
      clientAuthenticationRoutes(() => {
        if (!clientAuthentication) fail("SERVICE_UNAVAILABLE", "Client authentication is unavailable")
        return clientAuthentication
      }, publicOrigin),
    )
    .route("/runtime/v1", machineRegistrationRoutes(registry))
    .route(
      "/runtime/v1",
      executionRoutes(() => {
        if (!execution) fail("SERVICE_UNAVAILABLE", "Execution binding is unavailable")
        return execution
      }),
    )
    .route(
      "/",
      runtimeConnectionRoutes(() => {
        if (!connections) fail("SERVICE_UNAVAILABLE", "Runtime connections are unavailable")
        return connections
      }, publicOrigin),
    )
    .get(
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
