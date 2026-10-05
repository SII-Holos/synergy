import { randomUUID, createHash } from "node:crypto"
import { Environment } from "."
import { EnvironmentProviders } from "./provider"
import { ExecutionProtocol, type Executor } from "./executor"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceBinding } from "../workspace/binding"
import { WorkspaceMounts } from "../workspace/mount"
import { RuntimeContext } from "../lifecycle/context"
import { WorkspaceTree } from "../workspace/tree"

export namespace EnvironmentResources {
  /** A model-facing file namespace, separate from any live Environment mount location. */
  export function virtualRoot(workspace?: WorkspaceCatalog.Info) {
    if (workspace?.backend?.provider !== "objects" || workspace.backend.spec.virtualRoot === undefined) return undefined
    return WorkspaceTree.VirtualRoot.parse(workspace.backend.spec.virtualRoot)
  }
  const context = RuntimeContext.createAsyncContext<{
    runtime: RuntimeContext.Instance
    resources: Resolved
    operationID: string
    sequence: number
  }>()
  export function current() {
    const value = context.getStore()
    if (value && value.runtime !== RuntimeContext.current()) throw new Error("File resources belong to another Runtime")
    return value?.resources
  }
  export function localFiles() {
    const resources = current()
    return (
      !resources ||
      resources.kind === "native" ||
      (resources.environment?.provider === "native" &&
        resources.workspace?.backend?.provider === "directory" &&
        resources.directory === resources.workspace.binding.path)
    )
  }
  export function provide<T>(resources: Resolved, operationID: string, fn: () => T): T {
    return context.run({ runtime: RuntimeContext.current(), resources, operationID, sequence: 0 }, fn)
  }
  export function nextOperationID() {
    const value = context.getStore()
    current()
    return `file_${createHash("sha256")
      .update(JSON.stringify([value?.operationID ?? randomUUID(), value ? value.sequence++ : 0]))
      .digest("hex")}`
  }
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
    selection?: Selection
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

  export async function select(input: Selection & { ownerID: string; needs: Needs; signal?: AbortSignal }) {
    if (input.workspaceID) virtualRoot(await WorkspaceCatalog.get(input.workspaceID, input.scopeID))
    const environment = input.needs.execution ? await Environment.select(input) : undefined
    return resolve({ ...input, environmentID: environment?.id ?? input.environmentID, needs: input.needs })
  }

  export async function prepareSandbox(resources: Resolved, input: ExecutionProtocol.SandboxInput) {
    const executor = resources.executor
    if (!executor?.prepareSandbox || !executor.releaseSandbox)
      return {
        command: input.command,
        args: input.args,
        sandboxed: false,
        skipReason: "Selected Environment has no sandbox",
      }
    const wrapper = await executor.prepareSandbox(input)
    const intentDigest = createHash("sha256")
      .update(JSON.stringify(ExecutionProtocol.SandboxInput.parse(input)))
      .digest("hex")
    return { ...wrapper, intentDigest, cleanup: () => executor.releaseSandbox!(wrapper.id) }
  }

  export async function resolve(input: Selection & { needs: Needs; signal?: AbortSignal }): Promise<Resolved> {
    const resolved = await resolveSelection(input)
    resolved.selection = {
      scopeID: input.scopeID,
      environmentID: input.environmentID,
      workspaceID: input.workspaceID,
      workspaceGeneration: input.workspaceGeneration,
    }
    return resolved
  }

  async function resolveSelection(input: Selection & { needs: Needs; signal?: AbortSignal }): Promise<Resolved> {
    input.signal?.throwIfAborted()
    if (!input.needs.workspace && !input.needs.execution) return result({ kind: "none" })
    if (input.needs.workspace && !input.workspaceID)
      throw new WorkspaceCatalog.Unavailable({ workspaceID: "", message: "This operation requires a Workspace" })
    let workspace = input.workspaceID ? await WorkspaceCatalog.get(input.workspaceID, input.scopeID) : undefined
    if (workspace) {
      virtualRoot(workspace)
      if (workspace.lifecycle !== "active" || workspace.binding.state !== "bound")
        throw new WorkspaceCatalog.Unavailable({
          workspaceID: workspace.id,
          message: "Workspace has no storage authority",
        })
      if (input.workspaceGeneration !== undefined && workspace.binding.generation !== input.workspaceGeneration)
        throw new WorkspaceCatalog.BindingChanged({ workspaceID: workspace.id, message: "Workspace binding changed" })
    }
    if (!input.needs.execution && !workspace?.activeMount) {
      if (workspace?.backend?.provider === "objects")
        return result({ kind: "objects", workspace, directory: virtualRoot(workspace) })
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
