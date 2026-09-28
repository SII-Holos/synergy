import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import type { RuntimeInvocationContextData } from "../plugin-runtime/protocol"

export namespace PluginInvocationWorkspace {
  const context = RuntimeContext.createAsyncContext<{
    scope: Scope
    workspace: Session.Info["workspace"]
    invocation: RuntimeInvocationContextData
    selection: EnvironmentResources.Selection
    versions: Map<string, string>
  }>()

  export function current() {
    return context.getStore()
  }

  export async function run<T>(
    invocation: RuntimeInvocationContextData,
    signal: AbortSignal,
    fn: (invocation: RuntimeInvocationContextData) => Promise<T>,
    capabilities: ReadonlySet<string>,
  ): Promise<T> {
    signal.throwIfAborted()
    if (
      !["workspace.read", "workspace.write", "shell.execute", "tool.invoke"].some((capability) =>
        capabilities.has(capability),
      )
    )
      return fn(invocation)
    const scope = await Scope.fromID(invocation.scopeId)
    if (!scope) throw new Error("Plugin invocation Scope is unavailable")
    const selectedWorkspace = ScopeContext.tryScope()?.id === scope.id ? ScopeContext.tryWorkspace() : undefined
    return ScopeContext.provide({
      scope,
      workspace: selectedWorkspace,
      async fn() {
        const session = invocation.sessionId ? await Session.get(invocation.sessionId) : undefined
        if (session && session.scope.id !== scope.id)
          throw new Error("Plugin invocation Session belongs to another Scope")
        const workspace = session ? session.workspace : ScopeContext.current.workspace
        const inherited = EnvironmentResources.current()
        const workspaceID = session
          ? session.workspaceID
          : inherited?.workspace?.scopeID === scope.id
            ? inherited.workspace.id
            : workspace?.id
        const record = workspaceID ? await WorkspaceCatalog.get(workspaceID, scope.id) : undefined
        if (workspace?.id) await WorkspaceBinding.validate(workspace.id, scope.id, workspace.generation)
        const selected = { ...invocation, directory: record?.activeMount?.path ?? workspace?.path }
        const selection: EnvironmentResources.Selection = {
          scopeID: scope.id,
          workspaceID,
          workspaceGeneration: record?.binding.generation,
          environmentID: session
            ? session.environmentID
            : (inherited?.environment?.id ?? inherited?.selection?.environmentID),
        }
        return ScopeContext.provide({
          scope,
          workspace,
          fn: () =>
            WorkspaceAccess.withinTask(async () => {
              signal.throwIfAborted()
              if (workspace) await WorkspaceAccess.use([workspace])
              const run = () =>
                context.run({ scope, workspace, selection, invocation: selected, versions: new Map() }, () =>
                  fn(selected),
                )
              return record
                ? WorkspaceState.provide(
                    { id: record.id, scopeID: record.scopeID, generation: record.binding.generation },
                    run,
                  )
                : run()
            }, signal),
        })
      },
    })
  }
}
