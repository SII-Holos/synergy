import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { ScopeContext } from "../scope/context"
import { Scope } from "../scope"
import z from "zod"
import path from "path"
import { existsSync, statSync } from "fs"
import { errors } from "./error"
import { SessionNav, ScopeNavEntry } from "../session/nav"
import { ManagedProjectArchiveError } from "../channel/managed-project-ownership"
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
      return c.json(ScopeContext.current.scope)
    },
  )
  .get(
    "/index",
    describeRoute({
      summary: "List scope navigation entries",
      description: "Get navigation entries for all known scopes, sorted by latest session activity.",
      operationId: "scope.index",
      responses: {
        200: {
          description: "Array of scope navigation entries",
          content: {
            "application/json": {
              schema: resolver(ScopeNavEntry.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const result = await SessionNav.buildScopeIndex()
      return c.json(result)
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
        409: {
          description: "Managed project archive conflict",
          content: {
            "application/json": {
              schema: resolver(ManagedProjectArchiveError.Schema),
            },
          },
        },
      },
    }),
    validator("param", z.object({ scopeID: z.string() })),
    validator(
      "json",
      z.object({
        name: z.string().optional(),
        icon: Scope.Info.shape.icon.optional(),
        pinned: z.number().nullable().optional(),
        archived: z.number().nullable().optional(),
        sandboxes: z.array(z.string()).optional(),
      }),
    ),
    async (c) => {
      const scopeID = c.req.valid("param").scopeID
      const body = c.req.valid("json")
      const directory = c.req.query("directory")

      // Resolve the target scope: an existing scopeID wins; otherwise fall
      // back to ?directory= so clients that only know the project worktree
      // (e.g. a freshly opened, not-yet-persisted project) can still update
      // it. The directory resolution persists the project on first save.
      let scope: Scope | undefined = await Scope.fromID(scopeID)
      if (!scope && directory) {
        const resolved = await Scope.fromDirectory(directory)
        scope = resolved.scope
      }
      if (!scope || scope.type !== "project") return c.json({ error: "Scope not found" }, 404)

      if (body.sandboxes !== undefined) {
        for (const entry of body.sandboxes) {
          if (!path.isAbsolute(entry)) return c.json({ error: `Sandbox path must be absolute: ${entry}` }, 400)
          if (!existsSync(entry) || !statSync(entry).isDirectory())
            return c.json({ error: `Sandbox path is not a directory: ${entry}` }, 400)
        }
      }
      const result = await Scope.updatePersisted({ ...body, scopeID: scope.id })
      return c.json(result)
    },
  )
  .delete(
    "/:scopeID",
    describeRoute({
      summary: "Archive scope",
      description: "Archive a scope. Archived scopes are hidden from the list but can be restored.",
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
        409: {
          description: "Managed project archive conflict",
          content: {
            "application/json": {
              schema: resolver(ManagedProjectArchiveError.Schema),
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
