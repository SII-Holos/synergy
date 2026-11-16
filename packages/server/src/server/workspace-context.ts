import { z } from "zod"
import type { Context, Next } from "hono"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { randomUUID } from "node:crypto"

const registration = RuntimeContext.state<{ origin?: ReturnType<typeof EnvironmentOrigin.registerHost> }>(() => ({}))

export function registerWorkspaceRequests() {
  registration().origin ??= EnvironmentOrigin.registerHost("http-workspace")
}

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
  const reference = { ...parsed.data }
  const scope = structuredClone(ScopeContext.current.scope)
  const signal = c.req.raw.signal
  const readonly = c.req.method === "GET" || c.req.method === "HEAD"
  const operationID = `request:${randomUUID()}`
  const selected = EnvironmentResources.current()
  const origin = selected ? selected.origin : registration().origin?.capture(operationID)
  if (!origin) throw new Error("Workspace HTTP request requires its original resource origin")
  await using resources = await EnvironmentResources.resolve({
    ...reference,
    origin,
    scopeID: scope.id,
    needs: { workspace: true },
    signal,
  })
  return EnvironmentResources.provide(resources, operationID, async () => {
    const workspace = EnvironmentResources.localFiles()
      ? await WorkspaceBinding.validate(reference.workspaceID, scope.id, reference.workspaceGeneration)
      : null
    return WorkspaceState.provide(
      { id: reference.workspaceID, scopeID: scope.id, generation: reference.workspaceGeneration },
      () =>
        WorkspaceAccess.task({ workspace, signal }, () =>
          ScopeRuntime.provide({
            scope,
            workspace,
            ensure: readonly ? "background" : true,
            fn: next,
          }),
        ),
    )
  })
}
