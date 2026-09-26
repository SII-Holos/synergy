import { BrowserProtocolError } from "@ericsanchezok/synergy-browser-core"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionWorkspaceRuntime } from "@ericsanchezok/synergy-harness/session/workspace-runtime"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { BrowserOwner } from "./owner"

export async function withinBrowserOwner<T>(
  owner: BrowserOwner.Info,
  fn: (resolved: BrowserOwner.Info) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  BrowserOwner.assertValid(owner)
  return SessionWorkspaceRuntime.withBinding(
    owner.sessionID ?? `browser-scope:${owner.scopeID}`,
    async () => {
      signal?.throwIfAborted()
      const session = owner.mode === "session" ? await Session.get(owner.sessionID!) : undefined
      const scope = session?.scope ?? (await Scope.resolve({ scopeID: owner.scopeID }))
      const workspaceID = session
        ? session.workspaceID
        : (owner.workspaceID ?? (ScopeContext.tryScope()?.id === scope.id ? ScopeContext.tryWorkspace()?.id : null))
      const workspace = workspaceID ? await WorkspaceBinding.validate(workspaceID, scope.id, owner.generation) : null
      if (
        scope.id !== owner.scopeID ||
        owner.directory !== (workspace?.path ?? null) ||
        (owner.workspaceID !== undefined && owner.workspaceID !== (workspaceID ?? null))
      ) {
        throw new BrowserProtocolError({
          code: "browser_workspace_changed",
          message: "The Browser Workspace changed. Refresh the session before issuing another command.",
          retryable: true,
        })
      }
      const resolved: BrowserOwner.Info = {
        ...owner,
        workspaceID: workspaceID ?? null,
        generation: workspace?.generation,
      }
      return ScopeContext.provide({
        scope,
        workspace,
        fn: () =>
          WorkspaceAccess.withinTask(async () => {
            if (workspace) await WorkspaceAccess.use([workspace])
            signal?.throwIfAborted()
            return fn(resolved)
          }, signal),
      })
    },
    signal,
  )
}
