import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ProjectWorktrees } from "../worktrees"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { ProjectDirectories } from "../directories"

const params = z.object({ scopeID: z.string().min(1) })
const response = (schema: z.ZodType) => ({
  description: "Project folders",
  content: { "application/json": { schema: resolver(schema) } },
})
const failures = {
  400: response(ProjectDirectories.Invalid.Schema),
  409: response(ProjectDirectories.Conflict.Schema),
}
async function result(c: import("hono").Context, action: () => Promise<unknown>) {
  try {
    return c.json(await action())
  } catch (error) {
    if (error instanceof ProjectDirectories.Invalid) return c.json(error.toObject(), 400)
    if (error instanceof ProjectDirectories.Conflict) return c.json(error.toObject(), 409)
    if (error instanceof WorkspaceAccess.BusyError)
      return c.json(
        {
          name: "ProjectDirectoriesConflict",
          data: { message: "Project folders are in use. Keep your changes and retry when tasks are idle." },
        },
        409,
      )
    throw error
  }
}
export function ProjectDirectoriesRoute() {
  return new Hono()
    .post(
      "/",
      describeRoute({
        summary: "Create a project from folders",
        operationId: "project.create",
        responses: { 200: response(ProjectDirectories.Created), ...failures },
      }),
      validator("json", ProjectDirectories.CreateInput),
      (c) => result(c, () => ProjectDirectories.create(c.req.valid("json"))),
    )
    .get(
      "/:scopeID/directories",
      describeRoute({
        summary: "Get project folders",
        operationId: "project.directories",
        responses: { 200: response(ProjectDirectories.Result) },
      }),
      validator("param", params),
      (c) => result(c, () => ProjectDirectories.get(c.req.valid("param").scopeID)),
    )
    .patch(
      "/:scopeID/directories",
      describeRoute({
        summary: "Save main and additional project folders",
        operationId: "project.updateDirectories",
        responses: { 200: response(ProjectDirectories.Result), ...failures },
      }),
      validator("param", params),
      validator("json", ProjectDirectories.UpdateInput),
      (c) => result(c, () => ProjectDirectories.update(c.req.valid("param").scopeID, c.req.valid("json"))),
    )
    .get(
      "/:scopeID/worktree-inventory",
      describeRoute({
        summary: "List Worktree identities without computing status or disk usage",
        operationId: "project.worktreeInventory",
        responses: { 200: response(ProjectWorktrees.Inventory) },
      }),
      validator("param", params),
      async (c) => {
        const scope = await Scope.resolve(c.req.valid("param"))
        const inventory = await ScopeContext.provide({
          scope,
          workspace: null,
          fn: () => ProjectWorktrees.inventory(scope.id),
        })
        c.header("x-synergy-epoch", inventory.sync.epoch)
        c.header("x-synergy-seq", String(inventory.sync.seq))
        return c.json(inventory)
      },
    )
    .get(
      "/:scopeID/worktree-details",
      describeRoute({
        summary: "Compute status, disk usage and cleanup protection for one Worktree",
        operationId: "project.worktreeDetails",
        responses: { 200: response(Worktree.Details), ...failures },
      }),
      validator("param", params),
      validator("query", z.object({ target: z.string().min(1), sourceWorkspaceID: z.string().optional() })),
      async (c) => {
        const scope = await Scope.resolve(c.req.valid("param"))
        const input = c.req.valid("query")
        return c.json(
          await ScopeContext.provide({
            scope,
            workspace: null,
            fn: () => Worktree.withSource(input.sourceWorkspaceID, () => Worktree.details(input)),
          }),
        )
      },
    )
    .get(
      "/:scopeID/worktrees",
      describeRoute({
        summary: "List project Worktrees with their original repositories",
        operationId: "project.worktrees",
        responses: { 200: response(Worktree.Info.array()) },
      }),
      validator("param", params),
      async (c) => {
        const scope = await Scope.resolve(c.req.valid("param"))
        return c.json(await ScopeContext.provide({ scope, workspace: null, fn: () => ProjectWorktrees.list(scope.id) }))
      },
    )
}
