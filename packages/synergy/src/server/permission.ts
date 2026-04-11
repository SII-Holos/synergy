import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { PermissionNext } from "../permission/next"
import z from "zod"
import { errors } from "./error"
import { Identifier } from "@/id/id"

export const PermissionRoute = new Hono()
  .post(
    "/session/:sessionID/permissions/:permissionID",
    describeRoute({
      summary: "Respond to permission",
      deprecated: true,
      description: "Approve or deny a permission request from the AI assistant.",
      operationId: "permission.respond",
      responses: {
        200: {
          description: "Permission processed successfully",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string(),
        permissionID: z.string(),
      }),
    ),
    validator("json", z.object({ response: PermissionNext.Reply })),
    async (c) => {
      const params = c.req.valid("param")
      PermissionNext.reply({
        requestID: params.permissionID,
        reply: c.req.valid("json").response,
      })
      return c.json(true)
    },
  )
  .post(
    "/permission/:requestID/reply",
    describeRoute({
      summary: "Respond to permission request",
      description: "Approve or deny a permission request from the AI assistant.",
      operationId: "permission.reply",
      responses: {
        200: {
          description: "Permission processed successfully",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        requestID: z.string(),
      }),
    ),
    validator("json", z.object({ reply: PermissionNext.Reply, message: z.string().optional() })),
    async (c) => {
      const params = c.req.valid("param")
      const json = c.req.valid("json")
      await PermissionNext.reply({
        requestID: params.requestID,
        reply: json.reply,
        message: json.message,
      })
      return c.json(true)
    },
  )
  .post(
    "/permission/allow-all",
    describeRoute({
      summary: "Set allow-all for a session",
      description:
        "Enable or disable allow-all mode for a session. When enabled, all permission requests are automatically approved and any currently pending permissions are resolved.",
      operationId: "permission.setAllowAll",
      responses: {
        200: {
          description: "Allow-all updated",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", z.object({ sessionID: Identifier.schema("session"), enabled: z.boolean() })),
    async (c) => {
      const json = c.req.valid("json")
      await PermissionNext.setAllowAll(json.sessionID, json.enabled)
      return c.json(true)
    },
  )
  .get(
    "/permission/allow-all",
    describeRoute({
      summary: "Check allow-all status",
      description: "Check if allow-all mode is enabled for a session.",
      operationId: "permission.isAllowingAll",
      responses: {
        200: {
          description: "Allow-all status",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("query", z.object({ sessionID: Identifier.schema("session") })),
    async (c) => {
      const enabled = await PermissionNext.isAllowingAll(c.req.valid("query").sessionID)
      return c.json(enabled)
    },
  )
  .get(
    "/permission",
    describeRoute({
      summary: "List pending permissions",
      description: "Get all pending permission requests across all sessions.",
      operationId: "permission.list",
      responses: {
        200: {
          description: "List of pending permissions",
          content: {
            "application/json": {
              schema: resolver(PermissionNext.Request.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const permissions = await PermissionNext.list()
      return c.json(permissions)
    },
  )
