import { randomUUID } from "node:crypto"
import { Environment } from "."
import { EnvironmentProviders } from "./provider"
import { ExecutionProtocol, type Executor } from "./executor"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceBinding } from "../workspace/binding"
import { WorkspaceMounts } from "../workspace/mount"
import { RuntimeContext } from "../lifecycle/context"

export namespace EnvironmentResources {
  export interface Needs {
    workspace?: boolean
    execution?: "exec" | "pty"
  }
  export interface Selection {
    scopeID: string
    environmentID?: string | null
    workspaceID?: string | null
    workspaceGeneration?: number
  }
  export interface Resolved extends AsyncDisposable {
    kind: "none" | "objects" | "native" | "execution"
    workspace?: WorkspaceCatalog.Info
    environment?: Environment.Info
    executor?: Executor
    runtime?: ExecutionProtocol.Description
    directory?: string
    release(): Promise<void>
  }

  function result(
    value: Omit<Resolved, "release" | typeof Symbol.asyncDispose>,
    release: () => Promise<void> = async () => {},
  ): Resolved {
    return { ...value, release, [Symbol.asyncDispose]: release }
  }

  export async function resolve(input: Selection & { needs: Needs; signal?: AbortSignal }): Promise<Resolved> {
    input.signal?.throwIfAborted()
    if (!input.needs.workspace && !input.needs.execution) return result({ kind: "none" })
    if (input.needs.workspace && !input.workspaceID)
      throw new WorkspaceCatalog.Unavailable({ workspaceID: "", message: "This operation requires a Workspace" })
    let workspace = input.workspaceID ? await WorkspaceCatalog.get(input.workspaceID, input.scopeID) : undefined
    if (workspace) {
      if (workspace.lifecycle !== "active" || workspace.binding.state !== "bound")
        throw new WorkspaceCatalog.Unavailable({
          workspaceID: workspace.id,
          message: "Workspace has no storage authority",
        })
      if (input.workspaceGeneration !== undefined && workspace.binding.generation !== input.workspaceGeneration)
        throw new WorkspaceCatalog.BindingChanged({ workspaceID: workspace.id, message: "Workspace binding changed" })
    }
    if (!input.needs.execution && !workspace?.activeMount) {
      if (workspace?.backend?.provider === "objects") return result({ kind: "objects", workspace })
      const location = RuntimeContext.current().host.workspaceLocation
      if (
        workspace?.backend?.provider === "directory" &&
        location &&
        workspace.binding.hostID === (await location.hostID())
      ) {
        const local = await WorkspaceBinding.validate(workspace.id, input.scopeID, input.workspaceGeneration)
        return result({ kind: "native", workspace, directory: local.path })
      }
    }
    const active = workspace?.activeMount
    const environmentID = input.needs.execution
      ? input.environmentID
      : (active?.target.environmentID ?? input.environmentID)
    if (!environmentID)
      throw new Environment.Unavailable({ environmentID: "", message: "This operation has no selected Environment" })
    if (active) {
      if (active.target.environmentID !== environmentID || active.state !== "active")
        throw new WorkspaceCatalog.Unavailable({
          workspaceID: workspace!.id,
          message: "Workspace live view is unavailable in the selected Environment",
        })
      await Environment.assertTarget(active.target, input.scopeID)
    }
    const selected = await Environment.get(environmentID, input.scopeID)
    const provider = EnvironmentProviders.get(selected.provider)
    const directory =
      workspace && !active && workspace.backend?.provider !== "objects"
        ? await provider.workspacePath?.(selected.spec, workspace)
        : undefined
    if (workspace && !active && workspace.backend?.provider !== "objects" && !directory)
      throw new WorkspaceCatalog.Unavailable({
        workspaceID: workspace.id,
        message: "Environment cannot attach this Workspace backend",
      })
    const use = await Environment.acquire(environmentID, {
      scopeID: input.scopeID,
      useID: `admission:${randomUUID()}`,
      kind: "admission",
      capabilities: [...(input.needs.execution ? [input.needs.execution] : []), ...(workspace ? ["files"] : [])],
      signal: input.signal,
    })
    try {
      const environment = await Environment.assertTarget(use.target, input.scopeID)
      if (active && !Environment.sameTarget(active.target, use.target))
        throw new Environment.Stale({ environmentID, message: "Workspace allocation changed during admission" })
      const request = Environment.requestOf(environment)
      const executor = await provider.connect?.(request, use.target)
      if (!executor?.describe)
        throw new Environment.Unavailable({
          environmentID,
          message: "Environment has no execution runtime description",
        })
      const runtime = ExecutionProtocol.Description.parse(await executor.describe())
      if (!Environment.sameTarget(runtime.target, use.target))
        throw new Environment.Stale({ environmentID, message: "Executor description belongs to another allocation" })
      if (workspace && !active) {
        workspace = await WorkspaceMounts.attach({
          workspaceID: workspace.id,
          scopeID: input.scopeID,
          environmentID,
          generation: workspace.binding.generation,
          directory,
        })
      }
      await Environment.assertTarget(use.target, input.scopeID)
      input.signal?.throwIfAborted()
      return result(
        {
          kind: "execution",
          workspace,
          environment,
          executor,
          runtime,
          directory: workspace?.activeMount?.path ?? runtime.directory,
        },
        use.release,
      )
    } catch (error) {
      await use.release()
      throw error
    }
  }
}
