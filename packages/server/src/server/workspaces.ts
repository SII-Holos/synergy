import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { errors } from "./error"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

export const WorkspacesRoute = () =>
  new Hono()
    .post(
      "/objects",
      describeRoute({
        summary: "Create a durable Workspace from an object-storage profile",
        operationId: "workspace.createObjects",
        responses: {
          200: {
            description: "Created Workspace",
            content: { "application/json": { schema: resolver(WorkspaceCatalog.Info) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("json", z.object({ profile: z.string().min(1), name: z.string().min(1).max(256).optional() }).strict()),
      async (c) =>
        c.json(
          await ResourceProfiles.createWorkspace({ ...c.req.valid("json"), scopeID: ScopeContext.current.scope.id }),
        ),
    )
    .get(
      "/:workspaceID/operations",
      describeRoute({
        summary: "List unfinished Workspace file operations",
        operationId: "workspace.operations",
        responses: {
          200: {
            description: "Unfinished file operations",
            content: { "application/json": { schema: resolver(WorkspaceOperations.Summary.array()) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string().min(1) })),
      async (c) => {
        const workspace = await WorkspaceCatalog.get(c.req.valid("param").workspaceID, ScopeContext.current.scope.id)
        return c.json(
          (await WorkspaceOperations.listActive(workspace.scopeID)).filter(
            (operation) => operation.workspaceID === workspace.id,
          ),
        )
      },
    )
    .post(
      "/:workspaceID/operations/:operationID/recover",
      describeRoute({
        summary: "Retry reconciliation of an existing Workspace operation",
        operationId: "workspace.recoverOperation",
        responses: {
          200: {
            description: "File operation outcome",
            content: { "application/json": { schema: resolver(WorkspaceOperations.Summary) } },
          },
          ...errors(400, 404, 409, 503),
        },
      }),
      validator("param", z.object({ workspaceID: z.string().min(1), operationID: z.string().min(1) })),
      async (c) => {
        const input = c.req.valid("param")
        const workspace = await WorkspaceCatalog.get(input.workspaceID, ScopeContext.current.scope.id)
        const operation = await WorkspaceOperations.get(input.operationID, workspace.scopeID)
        if (operation.workspaceID !== workspace.id)
          throw new Storage.NotFoundError({ message: "Operation does not belong to this Workspace" })
        return c.json(
          WorkspaceOperations.Summary.parse(await WorkspaceOperations.reconcile(operation.id, workspace.scopeID)),
        )
      },
    )
    .post(
      "/:workspaceID/detach",
      describeRoute({
        summary: "Save and detach an idle Workspace view",
        operationId: "workspace.detach",
        responses: {
          200: {
            description: "Workspace after saving",
            content: { "application/json": { schema: resolver(WorkspaceCatalog.Info) } },
          },
          ...errors(400, 404, 409, 503),
        },
      }),
      validator("param", z.object({ workspaceID: z.string().min(1) })),
      validator("json", z.object({ expectedRevision: z.number().int().positive() }).strict()),
      async (c) => {
        const workspace = await WorkspaceCatalog.get(c.req.valid("param").workspaceID, ScopeContext.current.scope.id)
        await WorkspaceMounts.detach({
          workspaceID: workspace.id,
          scopeID: workspace.scopeID,
          expectedRevision: c.req.valid("json").expectedRevision,
        })
        return c.json(await WorkspaceCatalog.get(workspace.id, workspace.scopeID))
      },
    )
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
