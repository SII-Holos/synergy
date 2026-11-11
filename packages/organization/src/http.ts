import { Hono } from "hono"
import { describeRoute, generateSpecs, resolver } from "hono-openapi"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { type Authentication } from "./auth"
import { apiTokenRoutes } from "./routes/api-tokens"
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
import { sharingRoutes } from "./routes/sharing"
import { commandRoutes } from "./routes/commands"
import { resourceRoutes } from "./routes/resources"
import { executionRoutes } from "./routes/execution"
import type { ExecutionGrants } from "./execution-grants"
import type { CommandForwarder } from "./command-forwarding"
import { gatewayRoutes } from "./routes/gateway"
import type { GatewayCalls } from "./gateway-calls"
import type { ConnectionGateway, ModelGateway } from "./gateway"
import { publicationRoutes } from "./routes/publications"
import { knowledgeRoutes } from "./routes/knowledge"
import { artifactRoutes } from "./routes/artifacts"
import { cloudRoutes } from "./routes/cloud"
import { handoffRoutes, handoffMachineRoutes } from "./routes/handoff"
import type { Handoffs } from "./handoff"
import { knowledgeExecutionRoutes } from "./routes/knowledge-execution"
import { sessionReadRoutes } from "./routes/session-read"
import type { SessionReadForwarder } from "./session-read"

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
  gateway?: { calls: GatewayCalls; models: ModelGateway; connections: ConnectionGateway },
  handoffs?: Handoffs,
  reads?: SessionReadForwarder,
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
        const requestedHeaders = new Set(
          (c.req.header("access-control-request-headers") ?? "")
            .split(",")
            .map((header) => header.trim().toLowerCase())
            .filter(Boolean),
        )
        c.header(
          "Access-Control-Allow-Headers",
          ["authorization", "content-type", ...(requestedHeaders.has("x-csrf-token") ? ["x-csrf-token"] : [])]
            .map((header) =>
              header.replace(
                /(^|-)([a-z])/g,
                (_, separator: string, character: string) => `${separator}${character.toUpperCase()}`,
              ),
            )
            .join(","),
        )
        if (c.req.method === "OPTIONS") return c.body(null, 204)
      }
      await next()
    })
    .use("*", async (c, next) => {
      if (
        /^\/runtime\/v1\/gateway\/(?:models\/[^/]+\/(?:chat\/completions|messages)|connections\/[^/]+)$/.test(
          c.req.path,
        )
      )
        return next()
      const maxSize = /^\/runtime\/v1\/gateway\/connections\/[^/]+\/mcp$/.test(c.req.path)
        ? 16 * 1024 * 1024
        : /^\/org\/v1\/sessions\/[^/]+\/sync\/batches$/.test(c.req.path)
          ? 1024 * 1024
          : c.req.method === "PUT" &&
              (/^\/org\/v1\/sessions\/[^/]+\/blobs\/[^/]+$/.test(c.req.path) ||
                /^\/org\/v1\/publications\/uploads\/[^/]+\/files\/[^/]+\/chunks$/.test(c.req.path))
            ? 4 * 1024 * 1024
            : c.req.method === "POST" && /^\/org\/v1\/cloud\/workspaces\/[^/]+\/write$/.test(c.req.path)
              ? 6 * 1024 * 1024
              : 64 * 1024
      return bodyLimit({ maxSize, onError: () => fail("INVALID_REQUEST", "Request body is too large") })(c, next)
    })
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
    .route("/org/v1", apiTokenRoutes(publicOrigin))
    .route("/org/v1", registrationRoutes(registry, publicOrigin))
    .route("/org/v1", sessionDirectoryRoutes(publicOrigin))
    .route("/org/v1", sharingRoutes(publicOrigin))
    .route(
      "/org/v1",
      sessionReadRoutes(() => {
        if (!reads) fail("SERVICE_UNAVAILABLE", "Private native reading is unavailable")
        return reads
      }, publicOrigin),
    )
    .route("/org/v1", resourceRoutes(publicOrigin))
    .route("/org/v1", publicationRoutes(publicOrigin))
    .route("/org/v1", knowledgeRoutes(publicOrigin))
    .route("/org/v1", artifactRoutes(publicOrigin))
    .route("/org/v1", cloudRoutes(publicOrigin))
    .route(
      "/org/v1",
      handoffRoutes(() => {
        if (!handoffs) fail("SERVICE_UNAVAILABLE", "Session handoff is unavailable")
        return handoffs
      }, publicOrigin),
    )
    .route(
      "/runtime/v1",
      handoffMachineRoutes(() => {
        if (!handoffs) fail("SERVICE_UNAVAILABLE", "Session handoff is unavailable")
        return handoffs
      }),
    )
    .route(
      "/runtime/v1",
      knowledgeExecutionRoutes(() => {
        if (!execution) fail("SERVICE_UNAVAILABLE", "Execution binding is unavailable")
        return execution
      }),
    )
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
      gatewayRoutes(() => {
        if (!gateway) fail("SERVICE_UNAVAILABLE", "Resource gateway is unavailable")
        return gateway
      }),
    )
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
