import type { Server } from "bun"
import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import type { RuntimeConnections, RuntimeSocket } from "../runtime-connection"
import { fail } from "../error"
import { browserCredentials, operation, validation } from "./shared"

export type RuntimeBindings = { server?: Server<RuntimeSocket> }

export function runtimeConnectionRoutes(connections: () => RuntimeConnections, publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono<{ Bindings: RuntimeBindings }>()
    .get(
      "/org/v1/runtimes/:runtimeID/connection",
      operation("orgRuntime.connection", "Read current Runtime connection availability", Runtime.ConnectionStatus),
      validator("param", z.strictObject({ runtimeID: Identity.ID }), validation),
      async (c) => c.json(await connections().status(credentials(c), c.req.valid("param").runtimeID)),
    )
    .get("/runtime/v1/connect", (c) => {
      if (c.req.header("origin") || c.req.header("cookie") || new URL(c.req.url).search)
        fail("INVALID_REQUEST", "Runtime connections require machine authentication without browser credentials")
      const server = c.env?.server
      if (!server) fail("SERVICE_UNAVAILABLE", "Runtime WebSocket transport is unavailable")
      if (!server.upgrade(c.req.raw, { data: connections().socket() }))
        fail("INVALID_REQUEST", "Expected a Runtime WebSocket upgrade")
      return new Response(null)
    })
}
