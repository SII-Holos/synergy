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
import { StorageRecovery } from "../storage/recovery"
import { Log } from "../util/log"
import { WorkspaceCheckpoints } from "./checkpoint"
import { WorkspaceEvidence } from "./evidence"
import { WorkspaceErrors } from "./errors"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { addAbortListener } from "node:events"

export namespace WorkspaceMounts {
  export type Selection = {
    workspaceID: string
    scopeID: string
    environmentID: string
    generation?: number
    directory?: string
  }
  const attaching = RuntimeContext.state(() => new Map<string, Promise<WorkspaceCatalog.Info>>())
  const detaching = RuntimeContext.state(() => new Map<string, Promise<WorkspaceCatalog.Info>>())

  export function register() {
    Environment.registerResourceOwner("workspace", beforeDeallocate, allocationLost)
    StorageRecovery.register("workspace-mounts", recover)
    RuntimeMaintenance.register("workspace-mounts", {
      version: 1,
      order: 240,
      async suspend(context) { await RuntimeMaintenance.assertDraining(context.lease) },
      async drain(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
        while (attaching().size || detaching().size) {
          context.signal.throwIfAborted()
          const aborted = Promise.withResolvers<never>()
          using listener = addAbortListener(context.signal, () => aborted.reject(context.signal.reason))
          await Promise.race([Promise.allSettled([...attaching().values(), ...detaching().values()]), aborted.promise])
        }
        for await (const info of indexedMounts(context.signal)) {
          if (info.activeMount?.state !== "preparing") continue
          const result = await (await connect(info)).inspect(reference(info))
          context.signal.throwIfAborted()
          if (result) await publishMounted(info, result)
        }
        const requirements = await inspectMaintenance(context.signal)
        if (requirements.length)
          throw new RuntimeMaintenance.Blocked({ message: "Workspace mount transitions require original native evidence", requirements })
      },
      inspect: (context) => inspectMaintenance(context.signal),
      async release(context) { await RuntimeMaintenance.assertReleasing(context.lease) },
    })
  }

  async function* indexedMounts(signal: AbortSignal) {
    for await (const row of Storage.records({ prefix: ["workspace_environment"], limit: 128 })) {
      signal.throwIfAborted()
      if (row.key.length !== 3 || typeof row.value !== "string")
        throw new Error("Workspace mount maintenance found an invalid native index")
      const info = await WorkspaceCatalog.get(row.key[2], row.value)
      if (info.scopeID !== row.value || info.id !== row.key[2] || info.activeMount?.target.environmentID !== row.key[1])
        throw new Error("Workspace mount maintenance found another native ownership identity")
      yield info
    }
  }
  async function inspectMaintenance(signal: AbortSignal): Promise<RuntimeMaintenance.Requirement[]> {
    const requirements = new Map<string, RuntimeMaintenance.Requirement>()
    const add = (code: string, label: string) => requirements.set(code, { owner: "workspace-mounts", code, label, recoverable: true })
    if (attaching().size || detaching().size) add("workspace_mount_request_active", "Wait for the original Workspace mount transition")
    for await (const info of indexedMounts(signal))
      if (info.activeMount!.state !== "active")
        add(`workspace_mount_${info.activeMount!.state}`, "Reconcile the original native mount receipt and final save")
    for await (const row of Storage.records({ prefix: ["workspace"], limit: 128 })) {
      signal.throwIfAborted()
      const info = WorkspaceCatalog.Info.parse(row.value)
      if (row.key.length !== 2 || row.key[1] !== info.id)
        throw new Error("Workspace mount maintenance found an invalid canonical catalog identity")
      if (!info.activeMount) continue
      const [scopeID] = await Storage.readMany([StoragePath.workspaceEnvironment(info.activeMount.target.environmentID, info.id)])
      if (scopeID !== info.scopeID)
        add("workspace_mount_index_missing", "Restore exact coverage of the canonical native Workspace view")
    }
    return [...requirements.values()]
  }

  export async function recover(progress?: () => void) {
    for (const key of await Storage.list(["workspace_environment"])) {
      const [scopeID] = await Storage.readMany<string>([key])
      progress?.()
      if (!scopeID) continue
      try {
        const info = await WorkspaceCatalog.get(key[2], scopeID)
        if (info.activeMount?.state === "preparing")
          await attach({ workspaceID: info.id, scopeID, environmentID: key[1], generation: info.binding.generation })
        else if (info.activeMount?.state === "saving") await detach({ workspaceID: info.id, scopeID })
      } catch (error) {
        Log.create({ service: "workspace-mounts" }).warn("Workspace view remains pending reconciliation", {
          workspaceID: key[2],
          error,
        })
      }
      progress?.()
    }
  }

  async function allocationLost(environment: Environment.Info) {
    let retained = false
    for (const key of await Storage.list(StoragePath.workspaceEnvironment(environment.id))) {
      await Storage.transaction(async () => {
        const info = await WorkspaceCatalog.get(key[2], environment.scopeID)
        if (!info.activeMount) return
        if (!Environment.sameTarget(info.activeMount.target, Environment.targetOf(environment)))
          throw new Error("Workspace allocation requires reconciliation")
        retained = true
        if (info.activeMount.state === "unavailable") return
        const next = WorkspaceCatalog.Info.parse({
          ...info,
          revision: info.revision + 1,
          activeMount: { ...info.activeMount, state: "unavailable" },
          updatedAt: Date.now(),
        })
        await Storage.write(StoragePath.workspace(info.id), next)
        await WorkspaceCatalog.publishUpdated(next)
      })
    }
    return retained
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

  /** Wait for this Runtime's writer; an orphaned preparing record is not recovery authority. */
  export async function waitForAttachment(input: { scopeID: string; workspaceID: string; signal?: AbortSignal }) {
    input.signal?.throwIfAborted()
    const pending = attaching().get(JSON.stringify([input.scopeID, input.workspaceID]))
    if (!pending) return
    const signal = input.signal
    if (!signal) {
      await pending
      return
    }
    const cancelled = Promise.withResolvers<never>()
    const aborted = () => cancelled.reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    try {
      if (signal.aborted) aborted()
      await Promise.race([pending, cancelled.promise])
    } finally {
      signal.removeEventListener("abort", aborted)
    }
  }

  async function mount(input: Selection) {
    await RuntimeMaintenance.assertAdmission()
    const useID = `mount:${input.workspaceID}`
    const use = await Environment.acquire(input.environmentID, {
      scopeID: input.scopeID,
      useID,
      kind: "admission",
      capabilities: ["files"],
    })
    let info: WorkspaceCatalog.Info
    let created = false
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
          if (!["preparing", "active"].includes(previous.activeMount.state))
            throw new WorkspaceCatalog.Unavailable({
              workspaceID: previous.id,
              message: "Workspace requires its original native save or unavailable-view reconciliation",
            })
          await Environment.retainUse(use.target, input.scopeID, useID)
          return previous
        }
        await RuntimeMaintenance.assertAdmission()
        const generation = (previous.mountGeneration ?? 0) + 1
        const next = WorkspaceCatalog.Info.parse({
          ...previous,
          revision: previous.revision + 1,
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
        await Environment.retainUse(use.target, input.scopeID, useID)
        await Storage.write(StoragePath.workspace(next.id), next)
        await WorkspaceCatalog.publishUpdated(next)
        await Storage.write(StoragePath.workspaceEnvironment(input.environmentID, next.id), next.scopeID)
        created = true
        return next
      })
    } catch (error) {
      if (!(error instanceof Storage.CommitUnknownError)) await use.release()
      throw error
    }
    const files = await connect(info)
    const active = info.activeMount!
    let result = await files.inspect(reference(info))
    if (!result) {
      if (active.state !== "preparing")
        throw new WorkspaceCatalog.Unavailable({
          workspaceID: info.id,
          message: "Workspace live view was lost; an earlier checkpoint cannot replace it implicitly",
        })
      if (!created)
        throw new WorkspaceCatalog.Unavailable({
          workspaceID: info.id,
          message: "Workspace preparation requires its original native mount receipt; an earlier head cannot recreate it",
        })
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
    return publishMounted(info, result)
  }

  async function publishMounted(info: WorkspaceCatalog.Info, raw: WorkspaceProtocol.Mount) {
    const result = WorkspaceProtocol.Mount.parse(raw)
    const active = info.activeMount!
    if (result.id !== active.id || result.workspaceID !== info.id || result.generation !== active.generation)
      throw new WorkspaceCatalog.BindingChanged({ workspaceID: info.id, message: "Native mount receipt belongs to another view" })
    return Storage.transaction(async () => {
      const latest = await WorkspaceCatalog.get(info.id, info.scopeID)
      assertMount(latest, info)
      await Environment.assertTarget(active.target, info.scopeID)
      if (latest.activeMount!.state === "active") {
        if (latest.activeMount!.path !== result.path)
          throw new WorkspaceCatalog.BindingChanged({ workspaceID: info.id, message: "Native mount receipt has another path" })
        await Environment.releaseUse(active.target, info.scopeID, `mount:${info.id}`)
        return latest
      }
      if (latest.activeMount!.state !== "preparing")
        throw new WorkspaceCatalog.BindingChanged({ workspaceID: info.id, message: "Native mount transition changed before publication" })
      const next = WorkspaceCatalog.Info.parse({
        ...latest,
        revision: latest.revision + 1,
        activeMount: { ...latest.activeMount!, path: result.path, state: "active" },
        updatedAt: Date.now(),
      })
      await Storage.write(StoragePath.workspace(info.id), next)
      await WorkspaceCatalog.publishUpdated(next)
      await Environment.releaseUse(active.target, info.scopeID, `mount:${info.id}`)
      return next
    })
  }

  export function reference(info: WorkspaceCatalog.Info): WorkspaceProtocol.Reference {
    if (!info.activeMount)
      throw new WorkspaceCatalog.Unavailable({ workspaceID: info.id, message: "Workspace has no active mount" })
    return { id: info.activeMount.id, workspaceID: info.id, generation: info.activeMount.generation }
  }

  export async function detach(input: {
    workspaceID: string
    scopeID: string
    expectedRevision?: number
  }): Promise<WorkspaceCatalog.Info> {
    const key = JSON.stringify([input.scopeID, input.workspaceID])
    const pending = detaching().get(key)
    if (pending) {
      await pending
      return detach(input)
    }
    const task = detachView(input)
    detaching().set(key, task)
    try {
      return await task
    } finally {
      detaching().delete(key)
    }
  }

  async function detachView(input: { workspaceID: string; scopeID: string; expectedRevision?: number }) {
    let info = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
    const assertRevision = (info: WorkspaceCatalog.Info) => {
      if (input.expectedRevision !== undefined && info.revision !== input.expectedRevision)
        throw new WorkspaceCatalog.BindingChanged({
          workspaceID: info.id,
          message: "Workspace changed before detachment",
        })
    }
    assertRevision(info)
    const mount = info.activeMount
    if (!mount) return info
    await RuntimeMaintenance.assertAdmission()
    const useID = `detach:${mount.id}`
    const use = await Environment.acquire(mount.target.environmentID, {
      scopeID: input.scopeID,
      useID,
      kind: "admission",
      capabilities: ["files"],
    })
    try {
      info = await Storage.transaction(async () => {
        await RuntimeMaintenance.assertAdmission()
        const latest = await WorkspaceCatalog.get(info.id, input.scopeID)
        assertRevision(latest)
        assertMount(latest, info)
        if ((await Environment.uses(mount.target.environmentID)).some((held) => held.id !== useID))
          throw new Environment.Busy({
            environmentID: mount.target.environmentID,
            message: "Environment is busy; release active resource users before detaching",
          })
        await Environment.assertTarget(mount.target, input.scopeID)
        const next = WorkspaceCatalog.Info.parse({
          ...latest,
          revision: latest.revision + 1,
          activeMount: { ...latest.activeMount!, state: "saving" },
          updatedAt: Date.now(),
        })
        await Environment.retainUse(use.target, input.scopeID, useID)
        await Storage.write(StoragePath.workspace(info.id), next)
        await WorkspaceCatalog.publishUpdated(next)
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
    return Storage.transaction(async () => {
      const latest = await WorkspaceCatalog.get(info.id, input.scopeID)
      assertMount(latest, info)
      await Environment.assertTarget(mount.target, input.scopeID)
      const next = WorkspaceCatalog.Info.parse({
        ...latest,
        revision: latest.revision + 1,
        activeMount: undefined,
        updatedAt: Date.now(),
      })
      await Storage.write(StoragePath.workspace(info.id), next)
      await WorkspaceCatalog.publishUpdated(next)
      await Storage.remove(StoragePath.workspaceEnvironment(mount.target.environmentID, info.id))
      await Environment.releaseUse(mount.target, input.scopeID, useID)
      return next
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
    status?: { effectsStarted?: boolean; before?: (WorkspaceProtocol.Reference & { manifest: string })[] }
    evidence?: { workspaceID: string; reference: WorkspaceEvidence.Reference }[]
  }) {
    const saved: Record<string, { revision: number; manifest: string | null }> = {}
    const checkpointFailures: WorkspaceProtocol.CheckpointFailure[] = []
    if (input.status?.effectsStarted === false) {
      for (const item of input.evidence ?? []) await WorkspaceEvidence.incomplete(item.reference)
      return { saved }
    }
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
      const attempt = await WorkspaceCheckpoints.begin(info, checkpointID(input.id, reference.id))
      const evidence = input.evidence?.find((item) => item.workspaceID === info.id)?.reference
      let checkpoint: WorkspaceProtocol.Checkpoint
      try {
        checkpoint = await files.checkpoint({
          id: attempt.id,
          mount: WorkspaceProtocol.Reference.parse(reference),
          executionID: input.id,
        })
      } catch (error) {
        // Provenance: https://github.com/SII-Holos/synergy/issues/1658
        // Local adaptation: only a confirmed directory replacement can finish without a successful checkpoint.
        if (info.backend?.provider === "objects" || !(error instanceof WorkspaceErrors.DirectoryIdentityChangedError))
          throw error
        await WorkspaceEvidence.incomplete(evidence)
        checkpointFailures.push({
          mount: WorkspaceProtocol.Reference.parse(reference),
          failure: WorkspaceErrors.failure(error),
        })
        continue
      }
      const before = input.status?.before?.find(
        (item) => item.id === reference.id && item.generation === reference.generation,
      )?.manifest
      if (evidence && !before) throw new Error("Execution has no physical Workspace baseline")
      const published = await save(
        attempt.workspace,
        files,
        { ...checkpoint, beforeManifest: before },
        (saved) =>
          checkpoint.isolated !== true || attempt.id !== checkpointID(input.id, reference.id)
            ? WorkspaceEvidence.incomplete(evidence)
            : WorkspaceEvidence.finish(evidence, saved, before ?? null, checkpoint.manifest),
        attempt,
      )
      if (published.content) saved[info.id] = published.content
    }
    return { saved, checkpointFailures: checkpointFailures.length ? checkpointFailures : undefined }
  }

  export async function save(
    info: WorkspaceCatalog.Info,
    files: WorkspaceFileHost,
    checkpoint: WorkspaceProtocol.Checkpoint,
    beforeRelease?: (workspace: WorkspaceCatalog.Info) => Promise<void>,
    attempt?: WorkspaceCheckpoints.Attempt,
  ) {
    if (JSON.stringify(checkpoint.mount) !== JSON.stringify(reference(info)))
      throw new Error("Workspace checkpoint belongs to another mount")
    if (attempt?.state === "saved" && attempt.saved) {
      await beforeRelease?.(attempt.saved)
      await files.acknowledge(checkpoint.id)
      return attempt.saved
    }
    if (info.backend?.provider !== "objects") {
      await files.acknowledge(checkpoint.id)
      return info
    }
    if (!checkpoint.manifest) throw new Error("Object-backed Workspace checkpoint has no manifest")
    if (checkpoint.beforeManifest) await preserveManifest(info, files, checkpoint.beforeManifest)
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
    let result: WorkspaceCatalog.Info
    try {
      result =
        latest.content?.manifest === checkpoint.manifest
          ? latest
          : await WorkspaceCatalog.publishContent(info, checkpoint.manifest)
    } catch (error) {
      if (attempt && WorkspaceCatalog.BindingChanged.isInstance(error)) await WorkspaceCheckpoints.conflict(attempt)
      throw error
    }
    if (attempt) await WorkspaceCheckpoints.saved(attempt, result)
    await beforeRelease?.(result)
    await files.acknowledge(checkpoint.id)
    return result
  }

  async function preserveManifest(info: WorkspaceCatalog.Info, files: WorkspaceFileHost, manifest: string) {
    const bytes = WorkspaceTree.verify(
      manifest,
      await files.getBlob(manifest, WorkspaceTree.manifestBytes),
      WorkspaceTree.manifestBytes,
    )
    const tree = WorkspaceTree.Manifest.parse(JSON.parse(new TextDecoder().decode(bytes)))
    const { store } = await WorkspaceContent.resolve({ workspaceID: info.id, scopeID: info.scopeID }, true)
    await transfer(tree, { get: (hash, size) => files.getBlob(hash, size) }, store)
    await store.put(manifest, bytes)
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

  export async function* releaseMounts(environment: Environment.Info) {
    const target = Environment.targetOf(environment)
    for await (const row of Storage.records({ prefix: ["workspace"], limit: 128 })) {
      const info = WorkspaceCatalog.Info.parse(row.value)
      if (info.activeMount?.target.environmentID !== environment.id) continue
      const [scopeID] = await Storage.readMany([StoragePath.workspaceEnvironment(environment.id, info.id)])
      if (
        row.key.length !== 2 ||
        row.key[1] !== info.id ||
        info.scopeID !== environment.scopeID ||
        scopeID !== info.scopeID
      )
        throw new Error("Environment release requires complete canonical mount coverage")
    }
    for await (const row of Storage.records<string>({
      prefix: StoragePath.workspaceEnvironment(environment.id),
      limit: 128,
    })) {
      if (row.key.length !== 3 || row.value !== environment.scopeID)
        throw new Error("Workspace allocation has an invalid native mount index")
      const info = await WorkspaceCatalog.get(row.key[2], environment.scopeID)
      if (
        !info.activeMount ||
        info.activeMount.state !== "active" ||
        !Environment.sameTarget(info.activeMount.target, target)
      )
        throw new Error("Workspace allocation requires reconciliation")
      yield { ...reference(info), path: info.activeMount.path }
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
        const next = WorkspaceCatalog.Info.parse({
          ...latest,
          revision: latest.revision + 1,
          activeMount: undefined,
          updatedAt: Date.now(),
        })
        await Storage.write(StoragePath.workspace(info.id), next)
        await WorkspaceCatalog.publishUpdated(next)
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
  export function checkpointID(operationID: string, mountID: string) {
    return `checkpoint_${createHash("sha256")
      .update(JSON.stringify([operationID, mountID]))
      .digest("hex")}`
  }
}
