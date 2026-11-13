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
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { addAbortListener } from "node:events"
import { EnvironmentUseOwnership } from "../environment/use-ownership"
import { WorkspaceFileSource } from "./file-source"

export namespace WorkspaceOperations {
  const ObjectWrite = WorkspaceProtocol.WriteInput.omit({ mount: true }).extend({ kind: z.literal("objects-write") })
  const ObjectChange = WorkspaceProtocol.ChangeInput.omit({ mount: true }).extend({ kind: z.literal("objects-change") })
  const RemoteWrite = WorkspaceProtocol.WriteInput.omit({ mount: true }).extend({
    kind: z.literal("files-write"),
    version: z.literal(1),
    source: WorkspaceFileSource.Record,
    reference: WorkspaceProtocol.Reference,
  })
  const RemoteChange = WorkspaceProtocol.ChangeInput.omit({ mount: true }).extend({
    kind: z.literal("files-change"),
    version: z.literal(1),
    source: WorkspaceFileSource.Record,
    reference: WorkspaceProtocol.Reference,
  })
  type Selection = {
    id: string
    scopeID: string
    workspaceID: string
    generation?: number
    signal?: AbortSignal
    files?: WorkspaceFileSource.Lease
  }
  type Change = (
    | {
        path: string
        data: string
        expectedVersion: string | null
        expectedEntryVersion?: string | null
        mode?: number
      }
    | { change: WorkspaceProtocol.Change }
  ) & { protectSensitive?: boolean }

  export const Info = z
    .object({
      id: z.string(),
      scopeID: z.string(),
      workspaceID: z.string(),
      generation: z.number().int().positive(),
      target: Environment.Target.optional(),
      input: z.union([
        RemoteWrite,
        RemoteChange,
        WorkspaceProtocol.WriteInput,
        WorkspaceProtocol.ChangeInput,
        ObjectWrite,
        ObjectChange,
      ]),
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
  interface UseInput {
    id: string
    scopeID: string
    workspaceID: string
    generation: number
    target: Environment.Target
    digest: string
    mount: WorkspaceProtocol.Reference
  }
  const useOwner = RuntimeContext.state(() => ({
    port: undefined as ReturnType<typeof EnvironmentUseOwnership.register<UseInput>> | undefined,
  }))

  function useInput(info: Info): UseInput {
    if (!info.target || !("mount" in info.input)) throw new Error("Workspace Use requires its mounted operation")
    return {
      id: info.id,
      scopeID: info.scopeID,
      workspaceID: info.workspaceID,
      generation: info.generation,
      target: info.target,
      digest: info.digest,
      mount: info.input.mount,
    }
  }
  function uses() {
    const port = useOwner().port
    if (!port) throw new Error("Workspace operation Use owner is unavailable")
    return port
  }

  export function register() {
    useOwner().port = EnvironmentUseOwnership.register<UseInput>("workspace-operation", {
      capture(value, phase) {
        const input = {
          ...value,
          target: Environment.Target.parse(value.target),
          mount: WorkspaceProtocol.Reference.parse(value.mount),
        }
        return {
          selector: {
            scopeID: input.scopeID,
            environmentID: input.target.environmentID,
            useID: useID(input.scopeID, input.id),
          },
          ownership: {
            kind: "workspace-operation",
            scopeID: input.scopeID,
            workspaceID: input.workspaceID,
            operationID: input.id,
          },
          async verify(target) {
            if (target && !Environment.sameTarget(target, input.target))
              throw new Error("Workspace operation Use target changed")
            if (phase === "admission") {
              const workspace = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
              if (
                workspace.binding.generation !== input.generation ||
                workspace.activeMount?.state !== "active" ||
                JSON.stringify(WorkspaceMounts.reference(workspace)) !== JSON.stringify(input.mount) ||
                !Environment.sameTarget(workspace.activeMount.target, input.target)
              )
                throw new Error("Workspace operation Use requires its selected native mount")
              return
            }
            const current = await get(input.id, input.scopeID)
            if (
              current.workspaceID !== input.workspaceID ||
              current.generation !== input.generation ||
              current.digest !== input.digest ||
              !current.target ||
              !Environment.sameTarget(current.target, input.target) ||
              !("mount" in current.input) ||
              JSON.stringify(current.input.mount) !== JSON.stringify(input.mount)
            )
              throw new Error("Workspace operation Use differs from its canonical native request")
          },
        }
      },
      async inspect(ownership, selector, target) {
        if (ownership.kind !== "workspace-operation")
          throw new Error("Workspace operation Use has another canonical owner")
        const current = await get(ownership.operationID, ownership.scopeID)
        if (
          current.scopeID !== selector.scopeID ||
          current.workspaceID !== ownership.workspaceID ||
          useID(current.scopeID, current.id) !== selector.useID ||
          !current.target ||
          !Environment.sameTarget(current.target, target) ||
          !("mount" in current.input)
        )
          throw new Error("Workspace Use differs from its original native operation")
      },
    })
    StorageRecovery.register("workspace-operations", recover)
    RuntimeMaintenance.register("workspace-operations", {
      version: 1,
      order: 225,
      async suspend(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
      },
      async drain(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
        while (pending().size) {
          context.signal.throwIfAborted()
          const aborted = Promise.withResolvers<never>()
          using listener = addAbortListener(context.signal, () => aborted.reject(context.signal.reason))
          await Promise.race([Promise.allSettled([...pending().values()]), aborted.promise])
        }
        for await (const row of Storage.records({ prefix: StoragePath.workspaceOperationActive(), limit: 128 })) {
          context.signal.throwIfAborted()
          const info = await indexedOperation(row)
          await reconcile(info.id, info.scopeID)
        }
        const requirements = await inspectMaintenance(context.signal)
        if (requirements.length)
          throw new RuntimeMaintenance.Blocked({
            message: "Workspace operations require native save reconciliation",
            requirements,
          })
      },
      async inspect(context) {
        const held =
          context.purpose === "organization-home-upgrade"
            ? await RuntimeMaintenance.operation(context.maintenanceID)
            : undefined
        if (held?.version === 2 && held.phase === "released") {
          await reconcileHomeUpgrade(context, "released")
          return []
        }
        return inspectMaintenance(context.signal)
      },
      reconcileFrozen: (context) => reconcileHomeUpgrade(context, "frozen"),
      reconcileReleasing: (context) => reconcileHomeUpgrade(context, "releasing"),
      async release(context) {
        context.signal.throwIfAborted()
      },
    })
  }

  async function indexedOperation(row: { key: string[]; value: unknown }) {
    if (row.key.length !== 3 || row.value !== true)
      throw new Error("Workspace maintenance found an invalid operation index")
    const info = await get(row.key[2], row.key[1])
    if (info.scopeID !== row.key[1] || info.id !== row.key[2])
      throw new Error("Workspace maintenance found another operation identity")
    return info
  }

  async function inspectMaintenance(
    signal: AbortSignal,
    homeUpgrade = false,
  ): Promise<RuntimeMaintenance.Requirement[]> {
    signal.throwIfAborted()
    const requirements = new Map<string, RuntimeMaintenance.Requirement>()
    const add = (code: string, label: string) =>
      requirements.set(code, { owner: "workspace-operations", code, label, recoverable: true })
    if (pending().size) add("workspace_request_active", "Wait for accepted Workspace requests and their original saves")
    for await (const row of Storage.records({ prefix: StoragePath.workspaceOperationActive(), limit: 128 })) {
      signal.throwIfAborted()
      const info = await indexedOperation(row)
      if (info.state !== "completed" && info.state !== "failed")
        add("workspace_save_unsettled", "Confirm the original Workspace mutation receipt, checkpoint and use release")
    }
    if (homeUpgrade) {
      for await (const row of Storage.records({ prefix: ["workspace_operation"], limit: 128 })) {
        signal.throwIfAborted()
        const info = Info.parse(row.value)
        if (row.key.length !== 3 || row.key[1] !== info.scopeID || row.key[2] !== info.id)
          throw new Error("Workspace operation has another canonical address")
        if (info.state !== "completed" && info.state !== "failed")
          add("workspace_save_unsettled", "Confirm the original canonical mutation, checkpoint and use release")
      }
    }
    return [...requirements.values()]
  }
  async function reconcileHomeUpgrade(context: RuntimeMaintenance.Context, phase: "frozen" | "releasing" | "released") {
    const held =
      phase === "released"
        ? await RuntimeMaintenance.assertReleased(context.lease)
        : phase === "releasing"
          ? await RuntimeMaintenance.assertReleasing(context.lease)
          : await RuntimeMaintenance.assertHeld(context.lease)
    if (held.version !== 2 || held.purpose !== "organization-home-upgrade" || held.phase !== phase)
      throw new RuntimeMaintenance.Blocked({
        message: "Cold Workspace inspection requires its original Home upgrade phase",
      })
    let requirements: RuntimeMaintenance.Requirement[]
    try {
      requirements = await inspectMaintenance(context.signal, true)
    } catch (cause) {
      context.signal.throwIfAborted()
      throw new RuntimeMaintenance.Blocked(
        {
          maintenanceID: held.maintenanceID,
          message: "Cold Workspace operations have invalid or foreign canonical ownership",
          requirements: [
            {
              owner: "workspace-operations",
              code: "workspace_operation_inventory_unknown",
              label: "Inspect the original canonical Workspace operations",
              recoverable: true,
            },
          ],
        },
        { cause },
      )
    }
    if (requirements.length)
      throw new RuntimeMaintenance.Blocked({
        maintenanceID: held.maintenanceID,
        message: "Original Workspace operations still require native settlement",
        requirements,
      })
    const after =
      phase === "released"
        ? await RuntimeMaintenance.assertReleased(context.lease)
        : phase === "releasing"
          ? await RuntimeMaintenance.assertReleasing(context.lease)
          : await RuntimeMaintenance.assertHeld(context.lease)
    if (JSON.stringify(after) !== JSON.stringify(held))
      throw new RuntimeMaintenance.Blocked({ message: "Cold Workspace inspection changed its original Home operation" })
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
    expectedEntryVersion?: string | null
    mode?: number
    protectSensitive?: boolean
    signal?: AbortSignal
    files?: WorkspaceFileSource.Lease
  }) {
    return operate(input, {
      path: input.path,
      data: Buffer.from(input.data).toString("base64"),
      expectedVersion: input.expectedVersion,
      expectedEntryVersion: input.expectedEntryVersion,
      protectSensitive: input.protectSensitive,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    })
  }

  export function mutate(
    input: Selection & { change: WorkspaceProtocol.Change; protectSensitive?: boolean; assertCurrent?: () => void },
  ) {
    return operate(
      input,
      {
        change: WorkspaceProtocol.Change.parse(input.change),
        protectSensitive: input.protectSensitive,
      },
      input.assertCurrent,
    )
  }

  async function operate(input: Selection, change: Change, sourceGuard?: () => void) {
    input = { ...input }
    const owner = WorkspaceContent.captureOwner(input.signal)
    const assert = () => {
      sourceGuard?.()
      owner()
    }
    const digest = WorkspaceTree.hash(
      new TextEncoder().encode(JSON.stringify({ workspaceID: input.workspaceID, ...change })),
    )
    return serial(input.id, input.scopeID, async () => {
      const [raw] = await Storage.readMany<unknown>([StoragePath.workspaceOperation(input.scopeID, input.id)])
      const existing = raw === undefined ? undefined : Info.parse(raw)
      if (existing) {
        if (existing.digest !== digest || (input.generation !== undefined && existing.generation !== input.generation))
          throw new Error("Workspace operation already has different input")
        return completed(await resume(existing))
      }
      assert()
      await RuntimeMaintenance.assertAdmission()
      assert()
      const workspace = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
      assert()
      if (input.generation !== undefined && input.generation !== workspace.binding.generation)
        throw new WorkspaceCatalog.BindingChanged({ workspaceID: workspace.id, message: "Workspace binding changed" })
      if (input.files) {
        const lease = input.files
        const source = WorkspaceFileSource.capture(lease, workspace)
        const operation =
          "change" in change
            ? RemoteChange.parse({
                id: input.id,
                reference: lease.reference,
                kind: "files-change",
                version: 1,
                source,
                ...change,
              })
            : RemoteWrite.parse({
                id: input.id,
                reference: lease.reference,
                kind: "files-write",
                version: 1,
                source,
                ...change,
              })
        const info = await Storage.transaction(
          async () => {
            assert()
            await RuntimeMaintenance.assertAdmission()
            WorkspaceFileSource.capture(lease, await WorkspaceCatalog.get(workspace.id, workspace.scopeID))
            return persist(
              Info.parse({
                id: input.id,
                scopeID: input.scopeID,
                workspaceID: workspace.id,
                generation: workspace.binding.generation,
                input: operation,
                digest,
                state: "submitted",
                createdAt: Date.now(),
                updatedAt: Date.now(),
              }),
            )
          },
          {
            commitGuard() {
              assert()
              lease.assert()
            },
          },
        )
        const retain = WorkspaceContent.captureOwner()
        try {
          const checkpoint = await ("change" in operation
            ? lease.files.mutate(WorkspaceProtocol.ChangeInput.parse({ ...operation, mount: operation.reference }))
            : lease.files.write(WorkspaceProtocol.WriteInput.parse({ ...operation, mount: operation.reference })))
          return await finishRemote(info, lease, checkpoint)
        } catch (error) {
          retain()
          if (error instanceof WorkspaceFileSource.Rejected) {
            await persist({
              ...info,
              state: "failed",
              failure: error.failure,
              error: error.message,
              updatedAt: Date.now(),
            })
            throw WorkspaceErrors.restore(error.failure)
          }
          let receipt: WorkspaceProtocol.CheckpointStatus | undefined
          try {
            receipt = await lease.files.checkpointStatus(info.id)
          } catch {}
          if (
            receipt?.state === "failed" &&
            receipt.id === info.id &&
            JSON.stringify(receipt.mount) === JSON.stringify(operation.reference)
          ) {
            await persist({
              ...info,
              state: "failed",
              error: receipt.error,
              failure: receipt.failure,
              updatedAt: Date.now(),
            })
            if (receipt.failure) throw WorkspaceErrors.restore(receipt.failure)
            throw error
          }
          await persist({
            ...info,
            state: "unknown",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: Date.now(),
          })
          throw error
        }
      }
      if (!workspace.activeMount) {
        const operation =
          "change" in change
            ? ObjectChange.parse({ id: input.id, kind: "objects-change", ...change })
            : ObjectWrite.parse({ id: input.id, kind: "objects-write", ...change })
        const prepared =
          "change" in change
            ? await WorkspaceContent.prepareChange(input, change.change, change.protectSensitive)
            : await WorkspaceContent.prepareWrite(input, { ...change, data: Buffer.from(change.data, "base64") })
        assert()
        const info = await Storage.transaction(
          async () => {
            await RuntimeMaintenance.assertAdmission()
            await prepared.publish()
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
          },
          { commitGuard: assert },
        )
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
        ownership: uses().admission({
          id: input.id,
          scopeID: input.scopeID,
          workspaceID: workspace.id,
          generation: workspace.binding.generation,
          target: workspace.activeMount.target,
          digest,
          mount: WorkspaceMounts.reference(workspace),
        }),
      })
      let recorded = false
      try {
        const info = await Storage.transaction(async () => {
          await RuntimeMaintenance.assertAdmission()
          const latest = await WorkspaceCatalog.get(workspace.id, input.scopeID)
          if (
            latest.activeMount?.id !== workspace.activeMount!.id ||
            latest.activeMount?.state !== "active" ||
            latest.binding.generation !== workspace.binding.generation ||
            !Environment.sameTarget(use.target, workspace.activeMount!.target)
          )
            throw new WorkspaceCatalog.BindingChanged({ workspaceID: workspace.id, message: "Workspace mount changed" })
          const info = await persist(
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
          await Environment.retainUse(
            use.target,
            input.scopeID,
            useID(input.scopeID, input.id),
            uses().retention(useInput(info)),
          )
          return info
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
    if ("kind" in info.input && (info.input.kind === "files-write" || info.input.kind === "files-change")) {
      if (workspace.binding.generation !== info.generation)
        throw new WorkspaceCatalog.BindingChanged({
          workspaceID: workspace.id,
          message: "Workspace file binding changed",
        })
      const lease = await WorkspaceFileSource.restore(info.input.source, workspace)
      try {
        const receipt = await lease.files.checkpointStatus(info.id)
        if (!receipt) return persist({ ...info, state: "unknown", updatedAt: Date.now() })
        if (receipt.id !== info.id || JSON.stringify(receipt.mount) !== JSON.stringify(info.input.reference))
          throw new Error("Remote Workspace receipt belongs to another original operation")
        if (receipt.state === "failed")
          return persist({
            ...info,
            state: "failed",
            error: receipt.error,
            failure: receipt.failure,
            updatedAt: Date.now(),
          })
        if ((receipt.state !== "saved" && receipt.state !== "released") || !receipt.checkpoint)
          return persist({ ...info, state: "unknown", updatedAt: Date.now() })
        return await finishRemote(info, lease, receipt.checkpoint)
      } finally {
        await lease.release()
      }
    }
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
        await Environment.releaseUse(
          info.target!,
          info.scopeID,
          useID(info.scopeID, info.id),
          uses().retirement(useInput(info)),
        )
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
      await Environment.releaseUse(
        info.target!,
        info.scopeID,
        useID(info.scopeID, info.id),
        uses().retirement(useInput(info)),
      )
      return persist({ ...info, state: "completed", error: undefined, updatedAt: Date.now() })
    })
  }

  async function finishRemote(info: Info, lease: WorkspaceFileSource.Lease, value: WorkspaceProtocol.Checkpoint) {
    const checkpoint = WorkspaceProtocol.Checkpoint.parse(value)
    if (
      !("reference" in info.input) ||
      checkpoint.id !== info.id ||
      JSON.stringify(checkpoint.mount) !== JSON.stringify(info.input.reference)
    )
      throw new Error("Remote Workspace checkpoint belongs to another original operation")
    lease.assert()
    await lease.files.acknowledge(info.id)
    lease.assert()
    return Storage.transaction(
      async () => {
        lease.assert()
        return persist({
          ...info,
          state: "completed",
          error: undefined,
          beforeManifest: checkpoint.beforeManifest ?? null,
          afterManifest: checkpoint.manifest,
          updatedAt: Date.now(),
        })
      },
      { commitGuard: lease.assert },
    )
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
