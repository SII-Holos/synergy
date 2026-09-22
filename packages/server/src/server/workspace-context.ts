import { z } from "zod"
import type { Context, Next } from "hono"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"

export const WorkspaceReferenceQuery = z.object({
  workspaceID: z.string().min(1),
  workspaceGeneration: z.coerce.number().int().positive(),
})

export const RawWorkspacePath = /^\/workspace\/files\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/

export async function provideWorkspace(c: Context, next: Next) {
  const raw = RawWorkspacePath.exec(c.req.path)
  const parsed = WorkspaceReferenceQuery.safeParse(
    raw ? { workspaceID: raw[2], workspaceGeneration: raw[3] } : c.req.query(),
  )
  if (!parsed.success) return c.json({ success: false, data: {}, errors: parsed.error.issues }, 400)
  const scope = ScopeContext.current.scope
  const workspace = await WorkspaceBinding.validate(parsed.data.workspaceID, scope.id, parsed.data.workspaceGeneration)
  return ScopeRuntime.provide({ scope, workspace, fn: next })
}
