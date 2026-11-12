import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import type { RuntimeInvocationContextData } from "../plugin-runtime/protocol"

export namespace PluginInvocationWorkspace {
  const registration = RuntimeContext.state<{ host?: ReturnType<typeof EnvironmentOrigin.registerHost> }>(() => ({}))
  const origins = RuntimeContext.createAsyncContext<EnvironmentOrigin.Captured>()
  const context = RuntimeContext.createAsyncContext<{
    scope: Scope
    workspace: Session.Info["workspace"]
    invocation: RuntimeInvocationContextData
    selection: EnvironmentResources.Selection
    origin: EnvironmentOrigin.Captured
    versions: Map<string, string>
  }>()

  export function current() {
    return context.getStore()
  }

  export function register() {
    registration().host ??= EnvironmentOrigin.registerHost("plugin-host")
  }

  export function captureOrigin(invocation: Pick<RuntimeInvocationContextData, "scopeId" | "sessionId">) {
    const frame = EnvironmentResources.current()
    if (frame && !frame.origin) throw new Error("Plugin invocation requires its original resource origin")
    const origin = origins.getStore() ?? frame?.origin ?? registration().host?.capture(crypto.randomUUID())
    if (!origin) throw new Error("Plugin invocation Host origin is unavailable")
    const captured = EnvironmentOrigin.selected(origin)
    if (
      captured.value.kind === "session" &&
      (captured.value.scopeID !== invocation.scopeId || captured.value.sessionID !== invocation.sessionId)
    )
      throw new Error("Plugin invocation differs from its original Session")
    return captured
  }

  export function withOrigin<T>(origin: EnvironmentOrigin.Input, fn: () => T): T {
    return origins.run(EnvironmentOrigin.selected(origin), fn)
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
    invocation = structuredClone(invocation)
    const origin = captureOrigin(invocation)
    const scope = await Scope.fromID(invocation.scopeId)
    origin.assertCurrent()
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
        await EnvironmentOrigin.assertAdmission(origin, {
          scopeID: scope.id,
          environmentID: selection.environmentID ?? undefined,
        })
        signal.throwIfAborted()
        return ScopeContext.provide({
          scope,
          workspace,
          fn: () =>
            WorkspaceAccess.withinTask(async () => {
              signal.throwIfAborted()
              if (workspace) await WorkspaceAccess.use([workspace])
              const run = () =>
                context.run({ scope, workspace, selection, origin, invocation: selected, versions: new Map() }, () =>
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
