import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Environment } from "."
import { EnvironmentProviders } from "./provider"
import { ExecutionProtocol, type Executor } from "./executor"
import { WorkspaceProtocol } from "../workspace/protocol"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceMounts } from "../workspace/mount"
import { JsonValue } from "../util/json-value"
import { StorageRecovery } from "../storage/recovery"
import { Log } from "../util/log"
import { WorkspaceEvidence } from "../workspace/evidence"

export namespace EnvironmentExecution {
  export const Info = z
    .object({
      id: ExecutionProtocol.ID,
      scopeID: z.string(),
      target: Environment.Target,
      workspaces: z.array(WorkspaceProtocol.Reference.extend({ readOnly: z.boolean().optional() })).optional(),
      evidence: z.array(z.object({ workspaceID: z.string(), reference: WorkspaceEvidence.Reference })).optional(),
      digest: z.string(),
      intentDigest: z.string().length(64).optional(),
      state: z.enum(["submitted", "running", "cancel_requested", "unknown", "exited", "unsaved", "saved", "completed"]),
      status: ExecutionProtocol.Status.optional(),
      saved: z.record(z.string(), JsonValue).optional(),
      outputCursor: z.number().int().nonnegative(),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .meta({ ref: "EnvironmentExecutionInfo" })
  export type Info = z.infer<typeof Info>
  const pending = RuntimeContext.state(() => new Map<string, Promise<Info>>())
  const finishing = RuntimeContext.state(() => new Map<string, Promise<Info>>())
  const connections = RuntimeContext.state(() => new Map<string, Promise<Executor>>())

  export function registerRecovery() {
    StorageRecovery.register("environment-execution", recover)
  }

  export async function recover() {
    for (const key of await Storage.list(StoragePath.environmentExecutionActive())) {
      try {
        const info = await reconcile(key[2], key[1])
        if (["exited", "unsaved", "saved"].includes(info.state)) await complete(info.id, info.scopeID)
      } catch (error) {
        Log.create({ service: "environment-execution" }).warn("Execution remains pending reconciliation", {
          id: key[2],
          error,
        })
      }
    }
  }

  export async function get(id: string, scopeID: string): Promise<Info> {
    const [record] = await Storage.readMany<unknown>([
      StoragePath.environmentExecution(scopeID, ExecutionProtocol.ID.parse(id)),
    ])
    if (!record) throw new Storage.NotFoundError({ message: "Environment execution not found" })
    return Info.parse(record)
  }

  export async function start(input: {
    id: string
    scopeID: string
    environmentID: string
    command: ExecutionProtocol.Command
    intentDigest?: string
    workspaces?: WorkspaceProtocol.Reference[]
    signal?: AbortSignal
  }): Promise<Info> {
    const id = ExecutionProtocol.ID.parse(input.id)
    if (input.command.writableRoots?.length !== 0) {
      const mounted = (await WorkspaceCatalog.list(input.scopeID)).filter(
        (info) => info.activeMount?.target.environmentID === input.environmentID,
      )
      const roots = input.command.writableRoots
      const affected = mounted.filter((info) => {
        if (roots === null) return true
        const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()
        const mount = normalize(info.activeMount!.path)
        return roots.some((root) => {
          const candidate = normalize(root)
          return candidate === mount || candidate.startsWith(mount + "/") || mount.startsWith(candidate + "/")
        })
      })
      const workspaces = [
        ...new Map(
          [...(input.workspaces ?? []), ...affected.map(WorkspaceMounts.reference)].map((reference) => [
            reference.id,
            reference,
          ]),
        ).values(),
      ].sort((a, b) => a.id.localeCompare(b.id))
      input = {
        ...input,
        workspaces,
        command: {
          ...input.command,
          capture: workspaces,
          writableRoots:
            roots === null ? null : [...new Set([...roots, ...affected.map((info) => info.activeMount!.path)])],
        },
      }
    }
    const digest = ExecutionProtocol.digest(input.command)
    const key = JSON.stringify([input.scopeID, id])
    const previous = pending().get(key)
    if (previous) {
      const info = await previous
      verifyInput(info, input.environmentID, digest, input.workspaces, input.intentDigest)
      return info
    }
    const promise = submit({ ...input, id, digest })
    pending().set(key, promise)
    try {
      return await promise
    } finally {
      pending().delete(key)
    }
  }

  async function submit(input: {
    id: string
    scopeID: string
    environmentID: string
    command: ExecutionProtocol.Command
    intentDigest?: string
    workspaces?: WorkspaceProtocol.Reference[]
    digest: string
    signal?: AbortSignal
  }) {
    const [existing] = await Storage.readMany<Info>([StoragePath.environmentExecution(input.scopeID, input.id)])
    if (existing) {
      verifyInput(existing, input.environmentID, input.digest, input.workspaces, input.intentDigest)
      return ["completed", "saved", "unsaved", "exited"].includes(existing.state)
        ? existing
        : reconcile(input.id, input.scopeID)
    }
    input.signal?.throwIfAborted()
    const use = await Environment.acquire(input.environmentID, {
      scopeID: input.scopeID,
      useID: useID(input.scopeID, input.id),
      kind: "admission",
      capabilities: [input.command.pty ? "pty" : "exec"],
      signal: input.signal,
    })
    let recorded = false
    try {
      const info = await Storage.transaction(async () => {
        await Environment.assertTarget(use.target, input.scopeID)
        const evidence: NonNullable<Info["evidence"]> = []
        for (const workspace of input.workspaces ?? []) {
          const info = await WorkspaceCatalog.get(workspace.workspaceID, input.scopeID)
          const mount = info.activeMount
          if (
            !mount ||
            mount.id !== workspace.id ||
            mount.generation !== workspace.generation ||
            mount.state !== "active" ||
            !Environment.sameTarget(mount.target, use.target)
          )
            throw new WorkspaceCatalog.BindingChanged({
              workspaceID: info.id,
              message: "Execution requires the selected active Workspace mount",
            })
          if (input.command.writableRoots?.length && !input.command.writableRoots.includes(mount.path))
            throw new Error("Execution must retain the Workspace root through checkpoint publication")
          if (input.command.writableRoots?.length !== 0) {
            const reference = await WorkspaceEvidence.begin(info)
            if (reference) evidence.push({ workspaceID: info.id, reference })
          }
        }
        const now = Date.now()
        const info = Info.parse({
          id: input.id,
          scopeID: input.scopeID,
          target: use.target,
          evidence,
          workspaces: input.workspaces?.map((reference) => ({
            ...reference,
            ...(input.command.writableRoots?.length === 0 ? { readOnly: true } : {}),
          })),
          digest: input.digest,
          intentDigest: input.intentDigest,
          state: "submitted",
          outputCursor: 0,
          createdAt: now,
          updatedAt: now,
        })
        await Environment.retainUse(use.target, input.scopeID, useID(input.scopeID, input.id))
        await write(info)
        return info
      })
      recorded = true
      const executor = await connect(info)
      if (input.signal?.aborted) {
        await cancel(input.id, input.scopeID)
        return get(input.id, input.scopeID)
      }
      const status = await executor.start({
        id: input.id,
        target: use.target,
        digest: input.digest,
        command: input.command,
      })
      return accept(info, status)
    } catch (error) {
      if (!recorded) await use.release()
      throw error
    }
  }

  export async function reconcile(id: string, scopeID: string): Promise<Info> {
    const info = await get(id, scopeID)
    if (["completed", "saved", "unsaved", "exited"].includes(info.state)) return info
    const executor = await connect(info)
    if (info.state === "cancel_requested") await executor.cancel(id, info.digest)
    const status = await executor.status(id)
    if (!status) return update(info, { state: "unknown" })
    return accept(info, status)
  }

  export async function cancel(id: string, scopeID: string): Promise<void> {
    const info = await get(id, scopeID)
    if (["completed", "saved", "unsaved", "exited"].includes(info.state)) return
    await update(info, { state: "cancel_requested" })
    await (await connect(info)).cancel(id, info.digest)
    await reconcile(id, scopeID)
  }

  export async function complete(
    id: string,
    scopeID: string,
    checkpoint: (info: Info) => Promise<NonNullable<Info["saved"]>> = WorkspaceMounts.checkpointExecution,
  ): Promise<Info> {
    const key = JSON.stringify([scopeID, id])
    const current = finishing().get(key)
    if (current) return current
    const promise = finish(id, scopeID, checkpoint)
    finishing().set(key, promise)
    try {
      return await promise
    } finally {
      finishing().delete(key)
    }
  }

  async function finish(id: string, scopeID: string, checkpoint: (info: Info) => Promise<NonNullable<Info["saved"]>>) {
    let info = await get(id, scopeID)
    if (info.state === "completed") return info
    if (
      !["exited", "unsaved", "saved"].includes(info.state) ||
      !info.status ||
      !ExecutionProtocol.terminal(info.status)
    )
      throw new Environment.Busy({
        environmentID: info.target.environmentID,
        message: "Physical process and stream completion must be confirmed before saving",
      })
    const executor = await connect(info)
    if (info.state !== "saved") {
      try {
        await captureOutput(info, executor)
        const saved = await checkpoint(info)
        info = await update(info, { state: "saved", saved })
      } catch (error) {
        await update(info, { state: "unsaved" })
        throw error
      }
    }
    await executor.release(id)
    return Storage.transaction(async () => {
      const latest = await get(id, scopeID)
      if (latest.state === "completed") return latest
      await Environment.assertTarget(info.target, scopeID)
      await Environment.releaseUse(info.target, scopeID, useID(scopeID, id))
      return write({ ...latest, state: "completed" })
    })
  }

  export async function output(
    id: string,
    scopeID: string,
    after = 0,
    limit = 128,
  ): Promise<ExecutionProtocol.Chunk[]> {
    const info = await get(id, scopeID)
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error("Invalid output cursor or limit")
    if (info.state !== "completed" && info.state !== "saved") return (await connect(info)).output(id, after, limit)
    const keys = Array.from({ length: Math.min(limit, Math.max(0, info.outputCursor - after)) }, (_, index) =>
      StoragePath.environmentOutput(scopeID, id, after + index + 1),
    )
    const chunks: ExecutionProtocol.Chunk[] = []
    for (const key of keys)
      chunks.push(ExecutionProtocol.Chunk.parse(JSON.parse(new TextDecoder().decode(await Storage.readBinary(key)))))
    return chunks
  }

  export async function stdin(id: string, scopeID: string, data: Uint8Array, end = false) {
    if (data.byteLength > 65_536) throw new Error("Input frame exceeds 64 KiB")
    const info = await get(id, scopeID)
    await (await connect(info)).stdin(id, data, end)
  }

  export async function resize(id: string, scopeID: string, cols: number, rows: number) {
    const size = ExecutionProtocol.Command.shape.pty.unwrap().parse({ cols, rows })
    await (await connect(await get(id, scopeID))).resize(id, size.cols, size.rows)
  }

  export async function connect(info: Pick<Info, "scopeID" | "target">): Promise<Executor> {
    const environment = await Environment.assertTarget(info.target, info.scopeID)
    const provider = EnvironmentProviders.get(environment.provider)
    if (!provider.connect)
      throw new Environment.Unavailable({
        environmentID: environment.id,
        message: "Provider does not expose an Executor",
      })
    const key = JSON.stringify([info.scopeID, info.target])
    for (const cached of connections().keys()) {
      const [scopeID, target] = JSON.parse(cached) as [string, Environment.Target]
      if (scopeID === info.scopeID && target.environmentID === info.target.environmentID && cached !== key)
        connections().delete(cached)
    }
    let connection = connections().get(key)
    if (!connection) {
      connection = provider.connect(Environment.requestOf(environment), info.target)
      connections().set(key, connection)
      void connection.catch(() => {
        if (connections().get(key) === connection) connections().delete(key)
      })
    }
    return connection
  }

  async function captureOutput(info: Info, executor: Executor) {
    let after = (await get(info.id, info.scopeID)).outputCursor
    const end = info.status!.cursor
    while (after < end) {
      const chunks = await executor.output(info.id, after, 128)
      if (!chunks.length) throw new Error("Execution output is incomplete")
      for (const raw of chunks) {
        const chunk = ExecutionProtocol.Chunk.parse(raw)
        if (chunk.cursor !== after + 1 || chunk.cursor > end)
          throw new Error("Execution output cursor is discontinuous")
        await Storage.writeBinary(
          StoragePath.environmentOutput(info.scopeID, info.id, chunk.cursor),
          new TextEncoder().encode(JSON.stringify(chunk)),
        )
        after = chunk.cursor
      }
      await update(info, { outputCursor: after })
    }
  }

  async function accept(info: Info, raw: ExecutionProtocol.Status) {
    const status = ExecutionProtocol.Status.parse(raw)
    if (status.id !== info.id || status.digest !== info.digest || !Environment.sameTarget(status.target, info.target))
      throw new Environment.Stale({
        environmentID: info.target.environmentID,
        message: "Executor returned a mismatched operation or allocation",
      })
    return update(info, {
      status,
      state: ExecutionProtocol.terminal(status) ? "exited" : status.state === "unknown" ? "unknown" : "running",
    })
  }

  function verifyInput(
    info: Info,
    environmentID: string,
    digest: string,
    workspaces?: WorkspaceProtocol.Reference[],
    intentDigest?: string,
  ) {
    if (
      info.target.environmentID !== environmentID ||
      (info.intentDigest ? info.intentDigest !== intentDigest : Boolean(intentDigest) || info.digest !== digest) ||
      JSON.stringify((info.workspaces ?? []).map((reference) => WorkspaceProtocol.Reference.parse(reference))) !==
        JSON.stringify(workspaces ?? [])
    )
      throw new Error("Operation ID already has different input")
  }

  async function update(info: Info, changes: Partial<Info>): Promise<Info> {
    return Storage.transaction(async () => {
      await Environment.assertTarget(info.target, info.scopeID)
      const latest = await get(info.id, info.scopeID)
      if (!Environment.sameTarget(latest.target, info.target) || latest.digest !== info.digest)
        throw new Environment.Stale({
          environmentID: info.target.environmentID,
          message: "Operation changed during execution",
        })
      if (latest.state === "completed") return latest
      if (latest.state === "saved" && changes.state && changes.state !== "completed") return latest
      if (
        ["saved", "unsaved", "exited"].includes(latest.state) &&
        changes.state &&
        ["running", "unknown", "cancel_requested", "exited"].includes(changes.state)
      )
        return latest
      if (latest.state === "cancel_requested" && changes.state === "running")
        changes = { ...changes, state: "cancel_requested" }
      if (
        Object.entries(changes).every(
          ([key, value]) => JSON.stringify(latest[key as keyof Info]) === JSON.stringify(value),
        )
      )
        return latest
      return write({ ...latest, ...changes })
    })
  }

  async function write(info: Info) {
    const next = Info.parse({ ...info, updatedAt: Date.now() })
    await Storage.write(StoragePath.environmentExecution(info.scopeID, info.id), next)
    const active = StoragePath.environmentExecutionActive(info.scopeID, info.id)
    if (next.state === "completed") await Storage.remove(active)
    else await Storage.write(active, true)
    return next
  }

  function useID(scopeID: string, id: string) {
    return JSON.stringify(["execution", scopeID, id])
  }
}
