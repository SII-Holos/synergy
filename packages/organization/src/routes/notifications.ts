import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import {
  OrganizationNotificationProtocol as Notification,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationNotifications } from "../notifications"
import { browserCredentials } from "./shared"

export function notificationRoutes(owner: () => OrganizationNotifications, publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  const error = {
    description: "Organization error",
    content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
  }
  return new Hono().get(
    "/notifications",
    describeRoute({
      operationId: "orgNotifications.stream",
      summary: "Observe currently authorized live work notifications without retaining an inbox",
      responses: {
        200: {
          description: "Ephemeral metadata frames",
          content: { "text/event-stream": { schema: resolver(Notification.Frame) } },
        },
        400: error,
        401: error,
        403: error,
        503: error,
      },
    }),
    async (c) =>
      new Response(await owner().open(credentials(c), c.req.raw.signal), {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      }),
  )
}
