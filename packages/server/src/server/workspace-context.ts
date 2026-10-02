import { z } from "zod"
import type { Context, Next } from "hono"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { randomUUID } from "node:crypto"

export const WorkspaceReferenceQuery = z.object({
  workspaceID: z.string().min(1),
  workspaceGeneration: z.coerce.number().int().positive(),
  environmentID: z.string().min(1).optional(),
})

export const RawWorkspacePath = /^\/workspace\/files\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/

export async function provideWorkspace(c: Context, next: Next) {
  const raw = RawWorkspacePath.exec(c.req.path)
  const parsed = WorkspaceReferenceQuery.safeParse(
    raw ? { workspaceID: raw[2], workspaceGeneration: raw[3] } : c.req.query(),
  )
  if (!parsed.success) return c.json({ success: false, data: {}, errors: parsed.error.issues }, 400)
  const scope = ScopeContext.current.scope
  await using resources = await EnvironmentResources.resolve({
    ...parsed.data,
    scopeID: scope.id,
    needs: { workspace: true },
    signal: c.req.raw.signal,
  })
  return EnvironmentResources.provide(resources, `request:${randomUUID()}`, async () => {
    const workspace = EnvironmentResources.localFiles()
      ? await WorkspaceBinding.validate(parsed.data.workspaceID, scope.id, parsed.data.workspaceGeneration)
      : null
    return WorkspaceState.provide(
      { id: parsed.data.workspaceID, scopeID: scope.id, generation: parsed.data.workspaceGeneration },
      () =>
        WorkspaceAccess.task({ workspace, signal: c.req.raw.signal }, () =>
          ScopeRuntime.provide({
            scope,
            workspace,
            ensure: c.req.method === "GET" || c.req.method === "HEAD" ? "background" : true,
            fn: next,
          }),
        ),
    )
  })
}
