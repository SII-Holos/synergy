import { randomUUID, createHash } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { Environment } from "../environment"
import { EnvironmentProviders } from "../environment/provider"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceContent, type BlobStore } from "./content"
import { WorkspaceTree } from "./tree"
import { WorkspaceProtocol, type WorkspaceFileHost } from "./protocol"

export namespace WorkspaceMounts {
  export type Selection = {
    workspaceID: string
    scopeID: string
    environmentID: string
    generation?: number
    directory?: string
  }
  const attaching = RuntimeContext.state(() => new Map<string, Promise<WorkspaceCatalog.Info>>())
  const detaching = RuntimeContext.state(() => new Map<string, Promise<void>>())

  export function register() {
    Environment.registerResourceOwner("workspace", beforeDeallocate)
  }

  export async function attach(input: Selection): Promise<WorkspaceCatalog.Info> {
    const key = JSON.stringify([input.scopeID, input.workspaceID])
    const current = attaching().get(key)
    if (current) {
      await current
      return attach(input)
    }
    const pending = mount(input)
    attaching().set(key, pending)
    try {
      return await pending
    } finally {
      attaching().delete(key)
    }
  }

  async function mount(input: Selection) {
    const useID = `mount:${input.workspaceID}`
    const use = await Environment.acquire(input.environmentID, {
      scopeID: input.scopeID,
      useID,
      capabilities: ["files"],
    })
    let info: WorkspaceCatalog.Info
    try {
      info = await Storage.transaction(async () => {
        const previous = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
        if (previous.lifecycle !== "active" || previous.binding.state !== "bound")
          throw new WorkspaceCatalog.Unavailable({
            workspaceID: previous.id,
            message: "Workspace has no storage authority",
          })
        if (input.generation !== undefined && input.generation !== previous.binding.generation)
          throw new WorkspaceCatalog.BindingChanged({ workspaceID: previous.id, message: "Workspace binding changed" })
        if (previous.activeMount) {
          if (!Environment.sameTarget(previous.activeMount.target, use.target))
            throw new WorkspaceCatalog.Unavailable({
              workspaceID: previous.id,
              message: "Workspace is already mounted in another allocation",
            })
          return previous
        }
        const generation = (previous.mountGeneration ?? 0) + 1
        const next = WorkspaceCatalog.Info.parse({
          ...previous,
          mountGeneration: generation,
          activeMount: {
            id: `mount_${randomUUID().replaceAll("-", "")}`,
            target: use.target,
            generation,
            path: input.directory ?? "",
            state: "preparing",
          },
          updatedAt: Date.now(),
        })
        await Storage.write(StoragePath.workspace(next.id), next)
        await Storage.write(StoragePath.workspaceEnvironment(input.environmentID, next.id), next.scopeID)
        return next
      })
    } catch (error) {
      await use.release()
      throw error
    }
    const files = await connect(info)
    const active = info.activeMount!
    let result = await files.inspect(reference(info))
    if (!result) {
      let source: WorkspaceProtocol.MountInput["source"]
      if (info.backend?.provider === "objects") {
        const { store } = await WorkspaceContent.resolve({ workspaceID: info.id, scopeID: info.scopeID }, true)
        const tree = await WorkspaceContent.manifest(info, store)
        const bytes = WorkspaceTree.encode(tree)
        const manifest = WorkspaceTree.hash(bytes)
        await transfer(tree, store, { put: (hash, data) => files.putBlob(hash, data) })
        await files.putBlob(manifest, bytes)
        source = { kind: "materialized", manifest }
      } else {
        if (!active.path)
          throw new WorkspaceCatalog.Unavailable({
            workspaceID: info.id,
            message: "The Environment provider must resolve the directory mount",
          })
        source = { kind: "directory", path: active.path }
      }
      result = await files.mount({ ...reference(info), readOnly: active.readOnly, source })
    }
    const mounted = await Storage.transaction(async () => {
      const latest = await WorkspaceCatalog.get(info.id, info.scopeID)
      assertMount(latest, info)
      await Environment.assertTarget(active.target, info.scopeID)
      const next = WorkspaceCatalog.Info.parse({
        ...latest,
        activeMount: { ...latest.activeMount!, path: result.path, state: "active" },
        updatedAt: Date.now(),
      })
      await Storage.write(StoragePath.workspace(info.id), next)
      await Environment.releaseUse(active.target, info.scopeID, useID)
      return next
    })
    return mounted
  }

  export function reference(info: WorkspaceCatalog.Info): WorkspaceProtocol.Reference {
    if (!info.activeMount)
      throw new WorkspaceCatalog.Unavailable({ workspaceID: info.id, message: "Workspace has no active mount" })
    return { id: info.activeMount.id, workspaceID: info.id, generation: info.activeMount.generation }
  }

  export async function detach(input: { workspaceID: string; scopeID: string }) {
    const key = JSON.stringify([input.scopeID, input.workspaceID])
    const pending = detaching().get(key)
    if (pending) return pending
    const task = detachView(input)
    detaching().set(key, task)
    try {
      await task
    } finally {
      detaching().delete(key)
    }
  }

  async function detachView(input: { workspaceID: string; scopeID: string }) {
    let info = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
    const mount = info.activeMount
    if (!mount) return
    const useID = `detach:${mount.id}`
    const use = await Environment.acquire(mount.target.environmentID, {
      scopeID: input.scopeID,
      useID,
      capabilities: ["files"],
    })
    try {
      info = await Storage.transaction(async () => {
        const latest = await WorkspaceCatalog.get(info.id, input.scopeID)
        assertMount(latest, info)
        if ((await Environment.uses(mount.target.environmentID)).some((held) => held.id !== useID))
          throw new Environment.Busy({
            environmentID: mount.target.environmentID,
            message: "Environment is busy; release active resource users before detaching",
          })
        await Environment.assertTarget(mount.target, input.scopeID)
        const next = WorkspaceCatalog.Info.parse({
          ...latest,
          activeMount: { ...latest.activeMount!, state: "saving" },
          updatedAt: Date.now(),
        })
        await Storage.write(StoragePath.workspace(info.id), next)
        return next
      })
    } catch (error) {
      await use.release()
      throw error
    }
    const files = await connect(info)
    if (info.backend?.provider === "objects") {
      const checkpoint = await files.checkpoint({ id: checkpointID("detach", mount.id), mount: reference(info) })
      info = await save(info, files, checkpoint)
    }
    await files.detach(reference(info))
    await Storage.transaction(async () => {
      const latest = await WorkspaceCatalog.get(info.id, input.scopeID)
      assertMount(latest, info)
      await Environment.assertTarget(mount.target, input.scopeID)
      await Storage.write(StoragePath.workspace(info.id), { ...latest, activeMount: undefined, updatedAt: Date.now() })
      await Storage.remove(StoragePath.workspaceEnvironment(mount.target.environmentID, info.id))
      await Environment.releaseUse(mount.target, input.scopeID, useID)
    })
  }

  export async function connect(info: WorkspaceCatalog.Info, releasing?: Environment.Info): Promise<WorkspaceFileHost> {
    if (!info.activeMount)
      throw new WorkspaceCatalog.Unavailable({ workspaceID: info.id, message: "Workspace has no active mount" })
    const environment = releasing ?? (await Environment.assertTarget(info.activeMount.target, info.scopeID))
    if (!Environment.sameTarget(info.activeMount.target, Environment.targetOf(environment)))
      throw new Error("Workspace allocation changed")
    const provider = EnvironmentProviders.get(environment.provider)
    const executor = await provider.connect?.(Environment.requestOf(environment), info.activeMount.target)
    if (!executor?.files)
      throw new WorkspaceCatalog.Unavailable({
        workspaceID: info.id,
        message: "Environment has no Workspace file host",
      })
    return executor.files
  }

  export async function checkpointExecution(input: {
    id: string
    scopeID: string
    target: Environment.Target
    workspaces?: (WorkspaceProtocol.Reference & { readOnly?: boolean })[]
    status?: { effectsStarted?: boolean }
  }) {
    const saved: Record<string, { revision: number; manifest: string | null }> = {}
    if (input.status?.effectsStarted === false) return saved
    for (const reference of input.workspaces ?? []) {
      if (reference.readOnly) continue
      const info = await WorkspaceCatalog.get(reference.workspaceID, input.scopeID)
      if (
        !info.activeMount ||
        info.activeMount.id !== reference.id ||
        info.activeMount.generation !== reference.generation ||
        !Environment.sameTarget(info.activeMount.target, input.target)
      )
        throw new WorkspaceCatalog.BindingChanged({
          workspaceID: info.id,
          message: "Workspace mount changed during execution",
        })
      const files = await connect(info)
      const checkpoint = await files.checkpoint({
        id: checkpointID(input.id, reference.id),
        mount: WorkspaceProtocol.Reference.parse(reference),
        executionID: input.id,
      })
      const published = await save(info, files, checkpoint)
      if (published.content) saved[info.id] = published.content
    }
    return saved
  }

  export async function save(
    info: WorkspaceCatalog.Info,
    files: WorkspaceFileHost,
    checkpoint: WorkspaceProtocol.Checkpoint,
  ) {
    if (JSON.stringify(checkpoint.mount) !== JSON.stringify(reference(info)))
      throw new Error("Workspace checkpoint belongs to another mount")
    if (info.backend?.provider !== "objects") {
      await files.acknowledge(checkpoint.id)
      return info
    }
    if (!checkpoint.manifest) throw new Error("Object-backed Workspace checkpoint has no manifest")
    const bytes = WorkspaceTree.verify(
      checkpoint.manifest,
      await files.getBlob(checkpoint.manifest, WorkspaceTree.manifestBytes),
      WorkspaceTree.manifestBytes,
    )
    const tree = WorkspaceTree.Manifest.parse(JSON.parse(new TextDecoder().decode(bytes)))
    const { store } = await WorkspaceContent.resolve({ workspaceID: info.id, scopeID: info.scopeID }, true)
    await transfer(tree, { get: (hash, size) => files.getBlob(hash, size) }, store)
    await store.put(checkpoint.manifest, bytes)
    const latest = await WorkspaceCatalog.get(info.id, info.scopeID)
    assertMount(latest, info)
    const result =
      latest.content?.manifest === checkpoint.manifest
        ? latest
        : await WorkspaceCatalog.publishContent(info, checkpoint.manifest)
    await files.acknowledge(checkpoint.id)
    return result
  }

  async function transfer(
    tree: WorkspaceTree.Manifest,
    source: Pick<BlobStore, "get">,
    destination: Pick<BlobStore, "put">,
  ) {
    const copied = new Set<string>()
    for (const entry of tree.entries) {
      if (entry.kind !== "file") continue
      for (const chunk of entry.chunks) {
        if (copied.has(chunk.hash)) continue
        const bytes = WorkspaceTree.verify(chunk.hash, await source.get(chunk.hash, chunk.size), chunk.size)
        await destination.put(chunk.hash, bytes)
        copied.add(chunk.hash)
      }
    }
  }

  async function beforeDeallocate(environment: Environment.Info) {
    const target = Environment.targetOf(environment)
    for (const key of await Storage.list(StoragePath.workspaceEnvironment(environment.id))) {
      let info = await WorkspaceCatalog.get(key[2], environment.scopeID)
      if (!info.activeMount || !Environment.sameTarget(info.activeMount.target, target))
        throw new Error("Workspace allocation requires reconciliation")
      const files = await connect(info, environment)
      if (info.backend?.provider === "objects") {
        const checkpoint = await files.checkpoint({
          id: checkpointID("detach", info.activeMount.id),
          mount: reference(info),
        })
        info = await save(info, files, checkpoint)
      }
      await files.detach(reference(info))
      await Storage.transaction(async () => {
        const latest = await WorkspaceCatalog.get(info.id, info.scopeID)
        assertMount(latest, info)
        await Storage.write(StoragePath.workspace(info.id), {
          ...latest,
          activeMount: undefined,
          updatedAt: Date.now(),
        })
        await Storage.remove(key)
      })
    }
  }

  function assertMount(latest: WorkspaceCatalog.Info, expected: WorkspaceCatalog.Info) {
    if (
      latest.binding.generation !== expected.binding.generation ||
      latest.activeMount?.id !== expected.activeMount?.id ||
      latest.activeMount?.generation !== expected.activeMount?.generation
    )
      throw new WorkspaceCatalog.BindingChanged({ workspaceID: latest.id, message: "Workspace mount changed" })
  }
  function checkpointID(operationID: string, mountID: string) {
    return `checkpoint_${createHash("sha256")
      .update(JSON.stringify([operationID, mountID]))
      .digest("hex")}`
  }
}
