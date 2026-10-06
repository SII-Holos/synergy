import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { StorageRecovery } from "../storage/recovery"
import { Environment } from "../environment"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceErrors } from "./errors"
import { WorkspaceProtocol } from "./protocol"
import { WorkspaceContent } from "./content"
import { WorkspaceTree } from "./tree"
import { WorkspaceCheckpoints } from "./checkpoint"
import { WorkspaceMounts } from "./mount"
import { Log } from "../util/log"
import { WorkspaceEvidence } from "./evidence"

export namespace WorkspaceOperations {
  const ObjectWrite = WorkspaceProtocol.WriteInput.omit({ mount: true }).extend({ kind: z.literal("objects-write") })
  const ObjectChange = WorkspaceProtocol.ChangeInput.omit({ mount: true }).extend({ kind: z.literal("objects-change") })
  type Selection = { id: string; scopeID: string; workspaceID: string; generation?: number; signal?: AbortSignal }
  type Change = (
    | { path: string; data: string; expectedVersion: string | null }
    | { change: WorkspaceProtocol.Change }
  ) & { protectSensitive?: boolean }

  export const Info = z
    .object({
      id: z.string(),
      scopeID: z.string(),
      workspaceID: z.string(),
      generation: z.number().int().positive(),
      target: Environment.Target.optional(),
      input: z.union([WorkspaceProtocol.WriteInput, WorkspaceProtocol.ChangeInput, ObjectWrite, ObjectChange]),
      digest: z.string(),
      state: z.enum(["submitted", "unknown", "unsaved", "completed", "failed"]),
      error: z.string().optional(),
      failure: WorkspaceErrors.Failure.optional(),
      evidence: WorkspaceEvidence.Reference.optional(),
      beforeManifest: WorkspaceTree.Hash.nullable().optional(),
      afterManifest: WorkspaceTree.Hash.nullable().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .meta({ ref: "WorkspaceOperationInfo" })
  export type Info = z.infer<typeof Info>
  export const Summary = Info.pick({
    id: true,
    scopeID: true,
    workspaceID: true,
    generation: true,
    target: true,
    state: true,
    error: true,
    failure: true,
    createdAt: true,
    updatedAt: true,
  }).meta({ ref: "WorkspaceOperationSummary" })
  const pending = RuntimeContext.state(() => new Map<string, Promise<Info>>())

  export function register() {
    StorageRecovery.register("workspace-operations", recover)
  }

  export async function get(id: string, scopeID: string): Promise<Info> {
    return Info.parse(await Storage.read(StoragePath.workspaceOperation(scopeID, id)))
  }

  export async function listActive(scopeID: string) {
    const keys = await Storage.list(StoragePath.workspaceOperationActive(scopeID))
    return Promise.all(keys.map(async (key) => Summary.parse(await get(key[2], scopeID))))
  }

  async function persist(info: Info) {
    await Storage.transaction(async () => {
      await Storage.write(StoragePath.workspaceOperation(info.scopeID, info.id), info)
      const key = StoragePath.workspaceOperationActive(info.scopeID, info.id)
      if (info.state === "completed" || info.state === "failed") await Storage.remove(key)
      else await Storage.write(key, true)
    })
    return info
  }

  async function serial(id: string, scopeID: string, fn: () => Promise<Info>) {
    const key = JSON.stringify([scopeID, id])
    for (;;) {
      const current = pending().get(key)
      if (!current) break
      await current.catch(() => {})
    }
    const task = fn()
    pending().set(key, task)
    try {
      return await task
    } finally {
      pending().delete(key)
    }
  }

  export async function write(input: {
    id: string
    scopeID: string
    workspaceID: string
    generation?: number
    path: string
    data: Uint8Array
    expectedVersion: string | null
    protectSensitive?: boolean
    signal?: AbortSignal
  }) {
    return operate(input, {
      path: input.path,
      data: Buffer.from(input.data).toString("base64"),
      expectedVersion: input.expectedVersion,
      protectSensitive: input.protectSensitive,
    })
  }

  export function mutate(input: Selection & { change: WorkspaceProtocol.Change; protectSensitive?: boolean }) {
    return operate(input, {
      change: WorkspaceProtocol.Change.parse(input.change),
      protectSensitive: input.protectSensitive,
    })
  }

  async function operate(input: Selection, change: Change) {
    const digest = WorkspaceTree.hash(
      new TextEncoder().encode(JSON.stringify({ workspaceID: input.workspaceID, ...change })),
    )
    return serial(input.id, input.scopeID, async () => {
      const [existing] = await Storage.readMany<Info>([StoragePath.workspaceOperation(input.scopeID, input.id)])
      if (existing) {
        if (existing.digest !== digest || (input.generation !== undefined && existing.generation !== input.generation))
          throw new Error("Workspace operation already has different input")
        return completed(await resume(existing))
      }
      input.signal?.throwIfAborted()
      const workspace = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
      if (input.generation !== undefined && input.generation !== workspace.binding.generation)
        throw new WorkspaceCatalog.BindingChanged({ workspaceID: workspace.id, message: "Workspace binding changed" })
      if (!workspace.activeMount) {
        const operation =
          "change" in change
            ? ObjectChange.parse({ id: input.id, kind: "objects-change", ...change })
            : ObjectWrite.parse({ id: input.id, kind: "objects-write", ...change })
        const prepared =
          "change" in change
            ? await WorkspaceContent.prepareChange(input, change.change, change.protectSensitive)
            : await WorkspaceContent.prepareWrite(input, { ...change, data: Buffer.from(change.data, "base64") })
        input.signal?.throwIfAborted()
        const info = await Storage.transaction(async () => {
          await WorkspaceCatalog.publishContent(prepared.info, prepared.manifest)
          const evidence = await WorkspaceEvidence.begin(prepared.info)
          return persist(
            Info.parse({
              id: input.id,
              scopeID: input.scopeID,
              workspaceID: workspace.id,
              generation: workspace.binding.generation,
              input: operation,
              digest,
              state: evidence ? "unsaved" : "completed",
              evidence,
              beforeManifest: prepared.info.content?.manifest ?? null,
              afterManifest: prepared.manifest,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }),
          )
        })
        return resume(info)
      }
      if (workspace.activeMount.state !== "active" || workspace.binding.state !== "bound")
        throw new WorkspaceCatalog.Unavailable({ workspaceID: workspace.id, message: "Workspace has no active view" })
      const operation =
        "change" in change
          ? WorkspaceProtocol.ChangeInput.parse({
              id: input.id,
              mount: WorkspaceMounts.reference(workspace),
              ...change,
            })
          : WorkspaceProtocol.WriteInput.parse({ id: input.id, mount: WorkspaceMounts.reference(workspace), ...change })
      const use = await Environment.acquire(workspace.activeMount.target.environmentID, {
        scopeID: input.scopeID,
        useID: useID(input.scopeID, input.id),
        kind: "admission",
        capabilities: ["files"],
        signal: input.signal,
      })
      let recorded = false
      try {
        const info = await Storage.transaction(async () => {
          const latest = await WorkspaceCatalog.get(workspace.id, input.scopeID)
          if (
            latest.activeMount?.id !== workspace.activeMount!.id ||
            latest.activeMount?.state !== "active" ||
            latest.binding.generation !== workspace.binding.generation ||
            !Environment.sameTarget(use.target, workspace.activeMount!.target)
          )
            throw new WorkspaceCatalog.BindingChanged({ workspaceID: workspace.id, message: "Workspace mount changed" })
          await Environment.retainUse(use.target, input.scopeID, useID(input.scopeID, input.id))
          return persist(
            Info.parse({
              id: input.id,
              scopeID: input.scopeID,
              workspaceID: workspace.id,
              generation: workspace.binding.generation,
              target: use.target,
              input: operation,
              digest,
              state: "submitted",
              evidence: await WorkspaceEvidence.begin(latest),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }),
          )
        })
        recorded = true
        const files = await WorkspaceMounts.connect(workspace)
        await WorkspaceCheckpoints.begin(workspace, info.id)
        await ("change" in operation ? files.mutate(operation) : files.write(operation))
        return completed(await resume(info))
      } catch (error) {
        if (!recorded) await use.release()
        else {
          try {
            const files = await WorkspaceMounts.connect(workspace)
            if ((await files.checkpointStatus(input.id))?.state === "failed")
              await resume(await get(input.id, input.scopeID))
          } catch (cause) {
            Log.create({ service: "workspace-operations" }).warn("Rejected operation could not release its use", {
              id: input.id,
              error: cause,
            })
          }
        }
        throw error
      }
    })
  }

  export function reconcile(id: string, scopeID: string) {
    return serial(id, scopeID, async () => resume(await get(id, scopeID)))
  }

  async function resume(info: Info): Promise<Info> {
    if (info.state === "completed" || info.state === "failed") return info
    const workspace = await WorkspaceCatalog.get(info.workspaceID, info.scopeID)
    if (!("mount" in info.input)) {
      if (
        workspace.binding.generation !== info.generation ||
        info.beforeManifest === undefined ||
        info.afterManifest === undefined
      )
        throw new Error("Workspace operation content evidence is unavailable")
      await WorkspaceEvidence.finish(info.evidence, workspace, info.beforeManifest, info.afterManifest)
      return persist({ ...info, state: "completed", updatedAt: Date.now() })
    }
    if (!info.target) throw new Error("Workspace operation has no mounted execution target")
    if (
      workspace.binding.generation !== info.generation ||
      workspace.activeMount?.id !== info.input.mount.id ||
      workspace.activeMount.generation !== info.input.mount.generation ||
      !Environment.sameTarget(workspace.activeMount.target, info.target)
    )
      throw new WorkspaceCatalog.BindingChanged({
        workspaceID: info.workspaceID,
        message: "Workspace operation view changed",
      })
    const files = await WorkspaceMounts.connect(workspace)
    const receipt = await files.checkpointStatus(info.id)
    if (!receipt) return persist({ ...info, state: "unknown", updatedAt: Date.now() })
    if (receipt.state === "failed") {
      await WorkspaceEvidence.incomplete(info.evidence)
      return Storage.transaction(async () => {
        await Environment.releaseUse(info.target!, info.scopeID, useID(info.scopeID, info.id))
        return persist({
          ...info,
          state: "failed",
          error: receipt.error,
          failure: receipt.failure,
          updatedAt: Date.now(),
        })
      })
    }
    try {
      const original =
        receipt.checkpoint ?? (await ("change" in info.input ? files.mutate(info.input) : files.write(info.input)))
      const attempt = await WorkspaceCheckpoints.begin(workspace, info.id)
      const checkpoint =
        attempt.id === info.id
          ? original
          : {
              ...(await files.checkpoint({ id: attempt.id, mount: info.input.mount, operationID: info.id })),
              beforeManifest: original.beforeManifest,
            }
      await WorkspaceMounts.save(
        attempt.workspace,
        files,
        checkpoint,
        async (saved) => {
          if (info.evidence && !checkpoint.beforeManifest)
            throw new Error("Workspace operation has no physical baseline")
          if (checkpoint.isolated !== true || attempt.id !== info.id) await WorkspaceEvidence.incomplete(info.evidence)
          else
            await WorkspaceEvidence.finish(info.evidence, saved, checkpoint.beforeManifest ?? null, checkpoint.manifest)
        },
        attempt,
      )
      if (attempt.id !== info.id) await files.acknowledge(info.id)
    } catch (error) {
      await persist({
        ...info,
        state: "unsaved",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      })
      throw error
    }
    return Storage.transaction(async () => {
      await Environment.releaseUse(info.target!, info.scopeID, useID(info.scopeID, info.id))
      return persist({ ...info, state: "completed", error: undefined, updatedAt: Date.now() })
    })
  }

  function completed(info: Info) {
    if (info.failure) throw WorkspaceErrors.restore(info.failure)
    if (info.state !== "completed") throw new Error(info.error ?? `Workspace operation outcome is ${info.state}`)
    return info
  }

  export async function recover(progress?: () => void) {
    for (const key of await Storage.list(StoragePath.workspaceOperationActive())) {
      try {
        await reconcile(key[2], key[1])
      } catch (error) {
        Log.create({ service: "workspace-operations" }).warn("File operation remains pending reconciliation", {
          id: key[2],
          error,
        })
      }
      progress?.()
    }
  }

  function useID(scopeID: string, id: string) {
    return `file:${scopeID}:${id}`
  }
}
