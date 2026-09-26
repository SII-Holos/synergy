import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { errors } from "./error"

export const WorkspacesRoute = () =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List Workspaces in a Scope",
        operationId: "workspace.list",
        responses: {
          200: {
            description: "Workspace catalog",
            content: { "application/json": { schema: resolver(WorkspaceCatalog.Info.array()) } },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => c.json(await WorkspaceCatalog.list(ScopeContext.current.scope.id)),
    )
    .post(
      "/",
      describeRoute({
        summary: "Register an existing local directory as a Workspace",
        operationId: "workspace.register",
        responses: {
          200: {
            description: "Registered Workspace",
            content: { "application/json": { schema: resolver(WorkspaceCatalog.Info) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "json",
        z.object({ path: z.string().min(1).refine(path.isAbsolute, "An absolute directory is required") }),
      ),
      async (c) => c.json(await WorkspaceBinding.register(ScopeContext.current.scope.id, c.req.valid("json").path)),
    )
    .post(
      "/:workspaceID/sharing",
      describeRoute({
        summary: "Set explicitly shared writable Workspaces",
        operationId: "workspace.setSharing",
        responses: {
          200: {
            description: "Updated Workspace",
            content: { "application/json": { schema: resolver(WorkspaceCatalog.Info) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", z.object({ workspaceID: z.string().min(1) })),
      validator(
        "json",
        z.object({ expectedRevision: z.number().int().positive(), workspaceIDs: z.array(z.string().min(1)).max(64) }),
      ),
      async (c) =>
        c.json(
          await WorkspaceBinding.setSharing(
            c.req.valid("param").workspaceID,
            { scopeID: ScopeContext.current.scope.id, ...c.req.valid("json") },
            c.req.raw.signal,
          ),
        ),
    )
    .post(
      "/:workspaceID/rebind",
      describeRoute({
        summary: "Rebind a Workspace to an existing local directory",
        operationId: "workspace.rebind",
        responses: {
          200: {
            description: "Rebound Workspace",
            content: { "application/json": { schema: resolver(WorkspaceCatalog.Info) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", z.object({ workspaceID: z.string().min(1) })),
      validator(
        "json",
        z.object({
          expectedRevision: z.number().int().positive(),
          path: z.string().min(1).refine(path.isAbsolute, "An absolute directory is required"),
        }),
      ),
      async (c) =>
        c.json(
          await WorkspaceBinding.rebind(
            c.req.valid("param").workspaceID,
            { scopeID: ScopeContext.current.scope.id, ...c.req.valid("json") },
            c.req.raw.signal,
          ),
        ),
    )
