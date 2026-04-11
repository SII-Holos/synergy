import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "../scope/instance"
import { Scope } from "../scope"
import z from "zod"
import { errors } from "./error"

export const ScopeRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List all scopes",
      description: "Get a list of scopes that have been opened with Synergy.",
      operationId: "scope.list",
      responses: {
        200: {
          description: "List of scopes",
          content: {
            "application/json": {
              schema: resolver(Scope.Info.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const scopes = await Scope.list()
      return c.json(scopes)
    },
  )
  .get(
    "/current",
    describeRoute({
      summary: "Get current scope",
      description: "Retrieve the currently active scope that Synergy is working with.",
      operationId: "scope.current",
      responses: {
        200: {
          description: "Current scope information",
          content: {
            "application/json": {
              schema: resolver(Scope.Info),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(Instance.scope)
    },
  )
  .patch(
    "/:scopeID",
    describeRoute({
      summary: "Update scope",
      description: "Update scope properties such as name, icon and color.",
      operationId: "scope.update",
      responses: {
        200: {
          description: "Updated scope information",
          content: {
            "application/json": {
              schema: resolver(Scope.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ scopeID: z.string() })),
    validator(
      "json",
      z.object({
        name: z.string().optional(),
        icon: Scope.Info.shape.icon.optional(),
      }),
    ),
    async (c) => {
      const scopeID = c.req.valid("param").scopeID
      const body = c.req.valid("json")
      const scope = await Scope.updatePersisted({ ...body, scopeID })
      return c.json(scope)
    },
  )
  .delete(
    "/:scopeID",
    describeRoute({
      summary: "Remove scope",
      description: "Remove a scope from the tracked list. Does not delete scope files or session data.",
      operationId: "scope.remove",
      responses: {
        200: {
          description: "Scope removed",
          content: {
            "application/json": {
              schema: resolver(z.object({ ok: z.boolean() })),
            },
          },
        },
      },
    }),
    validator("param", z.object({ scopeID: z.string() })),
    async (c) => {
      const scopeID = c.req.valid("param").scopeID
      await Scope.remove(scopeID)
      return c.json({ ok: true })
    },
  )
