import { randomUUID, createHash } from "node:crypto"
import { Environment } from "."
import { EnvironmentProviders } from "./provider"
import { ExecutionProtocol, type Executor } from "./executor"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceBinding } from "../workspace/binding"
import { WorkspaceMounts } from "../workspace/mount"
import { RuntimeContext } from "../lifecycle/context"
import { WorkspaceTree } from "../workspace/tree"
import { EnvironmentOrigin } from "./origin"
import { WorkspaceFileSource } from "../workspace/file-source"
import { EnvironmentExecutionSource as Sources } from "./execution-source"
import { EnvironmentExecution } from "./execution"

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
    kind: "none" | "objects" | "native" | "execution" | "files" | "remote-execution"
    selection?: Selection
    origin?: EnvironmentOrigin.Captured
    workspace?: WorkspaceCatalog.Info
    environment?: Environment.Info
    executor?: Executor
    runtime?: ExecutionProtocol.Description
    directory?: string
    files?: WorkspaceFileSource.Lease
    source?: Sources.Lease
    release(): Promise<void>
  }
  export type Cleanup = Readonly<{ release(): Promise<void> }>
  const preparations = new WeakMap<Resolved, Promise<EnvironmentExecution.Preparation>>()
  const signals = new WeakMap<Resolved, AbortSignal>()
  const lifetimes = new WeakMap<
    Resolved,
    { assertOpen(): void; retain(completed: () => Promise<boolean>): () => Promise<void> }
  >()

  async function releaseAfterFailure(release: () => Promise<void>, error: unknown): Promise<never> {
    try {
      await release()
    } catch (failure) {
      throw new AggregateError([error, failure], "Environment resource resolution and cleanup failed", { cause: error })
    }
    throw error
  }

  function result(
    value: Omit<Resolved, "release" | typeof Symbol.asyncDispose>,
    release: () => Promise<void> = async () => {},
  ): Resolved {
    const resources: Resolved = { ...value, release: close, [Symbol.asyncDispose]: close }
    let requested = false,
      released = false
    let pending: Promise<void> | undefined
    let completed: (() => Promise<boolean>) | undefined
    async function close() {
      requested = true
      if (completed && !(await completed())) return
      return releaseOwned()
    }
    function releaseOwned() {
      if (released) return Promise.resolve()
      if (pending) return pending
      const work = releaseResources()
      pending = work
      void work
        .finally(() => {
          if (pending === work) pending = undefined
        })
        .catch(() => {})
      return work
    }
    async function releaseResources() {
      const errors: unknown[] = []
      const preparation = preparations.get(resources)
      if (preparation) {
        try {
          await (await preparation).release()
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await release()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length) throw new AggregateError(errors, "Environment preparation and resource cleanup failed")
      released = true
    }
    lifetimes.set(resources, {
      assertOpen() {
        if (requested || released) throw new Error("Environment resources are closing and cannot admit new preparation")
      },
      retain(inspect) {
        if (requested || released || completed)
          throw new Error("Environment resources already have their original owner")
        completed = inspect
        return async () => {
          if (!(await inspect())) throw new Error("Original process resources require completed native saving")
          requested = true
          await releaseOwned()
        }
      },
    })
    return resources
  }

  export async function retainExecution(resources: Resolved, submitted: EnvironmentExecution.Info) {
    const lifetime = lifetimes.get(resources)
    if (!lifetime) throw new Error("Execution retention requires its original admitted Environment resources")
    const original = preparations.get(resources)
    if (!original || resources.source) return
    const origin = resources.origin
    if (!origin || !resources.selection || !resources.runtime)
      throw new Error("Original process preparation requires its actual resolved resources")
    lifetime.assertOpen()
    origin.assertCurrent()
    const preparation = await original
    const info = EnvironmentExecution.Info.parse(submitted)
    if (
      info.source ||
      info.id !== preparation.id ||
      info.scopeID !== resources.selection.scopeID ||
      !Environment.sameTarget(info.target, resources.runtime.target) ||
      !Environment.sameTarget(info.target, preparation.target) ||
      JSON.stringify(info.origin) !== JSON.stringify(origin.value) ||
      JSON.stringify(info.origin) !== JSON.stringify(preparation.origin)
    )
      throw new Error("Original process preparation has another submitted native identity")
    const completed = async () => {
      origin.assertCurrent()
      const current = await EnvironmentExecution.get(info.id, info.scopeID)
      origin.assertCurrent()
      if (
        current.source ||
        current.digest !== info.digest ||
        !Environment.sameTarget(current.target, info.target) ||
        JSON.stringify(current.origin) !== JSON.stringify(info.origin)
      )
        throw new Error("Original process preparation changed its committed native identity")
      return current.state === "completed"
    }
    await completed()
    origin.assertCurrent()
    lifetime.assertOpen()
    return lifetime.retain(completed)
  }

  async function preparationFor(resources: Resolved, operationID?: string) {
    const lifetime = lifetimes.get(resources)
    if (!lifetime) throw new Error("Preparation requires its original admitted Environment resources")
    lifetime.assertOpen()
    if (!resources.origin || !resources.runtime || !resources.selection)
      throw new Error("Preparation requires its actual admitted native resources")
    const origin = resources.origin.value
    const id = origin.kind === "session" ? EnvironmentExecution.operationID(origin) : operationID
    if (!id) throw new Error("Host preparation requires its durable original operation identity")
    if (operationID !== undefined && operationID !== id)
      throw new Error("Preparation changed its original tool operation")
    let preparation = preparations.get(resources)
    if (!preparation) {
      preparation = EnvironmentExecution.prepareResources({
        id,
        scopeID: resources.selection.scopeID,
        target: resources.runtime.target,
        origin: resources.origin,
        workspaces: resources.workspace?.activeMount ? [WorkspaceMounts.reference(resources.workspace)] : [],
        signal: signals.get(resources),
      })
      preparations.set(resources, preparation)
    }
    return preparation
  }

  export async function select(
    input: Selection & { ownerID: string; origin?: EnvironmentOrigin.Input; needs: Needs; signal?: AbortSignal },
  ) {
    input = { ...input, needs: { ...input.needs } }
    if (input.needs.workspace || input.needs.execution) {
      const origin = EnvironmentOrigin.selected(input.origin)
      const selection = { ...input, origin }
      return EnvironmentOrigin.request(origin, async () => {
        input.signal?.throwIfAborted()
        await EnvironmentOrigin.assertAdmission(origin, {
          scopeID: selection.scopeID,
          environmentID: selection.environmentID ?? undefined,
        })
        return selectResources(selection)
      })
    }
    return selectResources(input)
  }
  async function selectResources(
    input: Selection & { ownerID: string; origin?: EnvironmentOrigin.Input; needs: Needs; signal?: AbortSignal },
  ) {
    if (input.workspaceID) virtualRoot(await WorkspaceCatalog.get(input.workspaceID, input.scopeID))
    return resolveOwned(input, input.ownerID)
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
    const preparation = resources.source ? undefined : await preparationFor(resources, input.operationID)
    const wrapper = await (preparation ? preparation.prepareSandbox(input) : executor.prepareSandbox(input))
    const intentDigest = createHash("sha256")
      .update(JSON.stringify(ExecutionProtocol.SandboxInput.parse(input)))
      .digest("hex")
    return {
      ...wrapper,
      intentDigest,
      cleanup: async () => {
        if (!preparation) return executor.releaseSandbox!(wrapper.id)
        const observed = await preparation.inspect()
        if (
          observed.state === "released" &&
          observed.sandboxes.some((sandbox) => sandbox.id === wrapper.id && sandbox.released)
        )
          return
        return preparation.releaseSandbox(wrapper.id)
      },
    }
  }

  export async function resolve(
    input: Selection & { origin?: EnvironmentOrigin.Input; needs: Needs; signal?: AbortSignal },
    observeCleanup?: (cleanup: Cleanup) => void,
  ): Promise<Resolved> {
    return resolveOwned(input, undefined, observeCleanup)
  }
  async function resolveOwned(
    value: Selection & { origin?: EnvironmentOrigin.Input; needs: Needs; signal?: AbortSignal },
    ownerID?: string,
    observeCleanup?: (cleanup: Cleanup) => void,
  ): Promise<Resolved> {
    const input = { ...value, needs: { ...value.needs } }
    let observed = false
    const observe = (release: () => Promise<void>) => {
      observed = true
      observeCleanup?.(Object.freeze({ release }))
    }
    const origin = input.needs.workspace || input.needs.execution ? EnvironmentOrigin.selected(input.origin) : undefined
    async function perform() {
      input.signal?.throwIfAborted()
      const target = { scopeID: input.scopeID, environmentID: input.environmentID ?? undefined }
      if (origin) await EnvironmentOrigin.assertAdmission(origin, target)
      let resolved: Resolved | undefined
      if (input.needs.execution && origin) {
        if (input.needs.workspace && !input.workspaceID)
          throw new WorkspaceCatalog.Unavailable({ workspaceID: "", message: "This operation requires a Workspace" })
        const source = await Sources.open({
          selection: {
            scopeID: input.scopeID,
            environmentID: input.environmentID,
            workspaceID: input.workspaceID,
            workspaceGeneration: input.workspaceGeneration,
            ownerID: ownerID ?? (origin.value.kind === "session" ? origin.value.sessionID : origin.value.owner),
          },
          origin,
          needs: { workspace: input.needs.workspace, execution: input.needs.execution },
          signal: input.signal,
        })
        if (source)
          resolved = result(
            {
              kind: "remote-execution",
              source,
              runtime: source.runtime,
              executor: source.executor,
              directory: source.directory,
            },
            source.release,
          )
      }
      if (!resolved) {
        const environment =
          input.needs.execution && ownerID !== undefined ? await Environment.select({ ...input, ownerID }) : undefined
        resolved = await resolveSelection(
          { ...input, origin, environmentID: environment?.id ?? input.environmentID },
          observe,
        )
      }
      try {
        if (!observed) observe(resolved.release)
        if (origin)
          await EnvironmentOrigin.assertAdmission(origin, {
            scopeID: input.scopeID,
            environmentID: resolved.environment?.id ?? target.environmentID,
          })
        input.signal?.throwIfAborted()
        resolved.origin = origin
        resolved.selection = {
          scopeID: input.scopeID,
          environmentID: resolved.environment?.id ?? input.environmentID,
          workspaceID: input.workspaceID,
          workspaceGeneration: input.workspaceGeneration,
        }
        if (input.signal) signals.set(resolved, input.signal)
        return resolved
      } catch (error) {
        return releaseAfterFailure(resolved.release, error)
      }
    }
    return origin ? EnvironmentOrigin.request(origin, perform) : perform()
  }

  async function resolveSelection(
    input: Selection & { origin?: EnvironmentOrigin.Captured; needs: Needs; signal?: AbortSignal },
    observeCleanup: (release: () => Promise<void>) => void,
  ): Promise<Resolved> {
    input.signal?.throwIfAborted()
    if (!input.needs.workspace && !input.needs.execution) return result({ kind: "none" })
    if (input.needs.workspace && !input.workspaceID)
      throw new WorkspaceCatalog.Unavailable({ workspaceID: "", message: "This operation requires a Workspace" })
    let workspace = input.workspaceID ? await WorkspaceCatalog.get(input.workspaceID, input.scopeID) : undefined
    if (
      workspace?.activeMount?.state === "preparing" &&
      (!input.needs.execution || workspace.activeMount.target.environmentID === input.environmentID)
    ) {
      await WorkspaceMounts.waitForAttachment({
        scopeID: input.scopeID,
        workspaceID: workspace.id,
        signal: input.signal,
      })
      workspace = await WorkspaceCatalog.get(workspace.id, input.scopeID)
    }
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
      if (workspace?.backend && WorkspaceFileSource.has(workspace.backend.provider)) {
        if (!input.origin)
          throw new WorkspaceCatalog.Unavailable({
            workspaceID: workspace.id,
            message: "Workspace files require their original resource origin",
          })
        const files = await WorkspaceFileSource.open({ workspace, origin: input.origin, signal: input.signal })
        return result({ kind: "files", workspace, files, directory: files.directory }, files.release)
      }
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
    if (!input.origin)
      throw new Environment.Unavailable({
        environmentID,
        message: "Environment admission requires its original resource origin",
      })
    const use = await Environment.acquire(environmentID, {
      scopeID: input.scopeID,
      ...(active && { expectedTarget: active.target }),
      useID: `admission:${randomUUID()}`,
      kind: "admission",
      ownership: input.origin,
      capabilities: [...(input.needs.execution ? [input.needs.execution] : []), ...(workspace ? ["files"] : [])],
      signal: input.signal,
    })
    try {
      observeCleanup(use.release)
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
      return releaseAfterFailure(use.release, error)
    }
  }
}
