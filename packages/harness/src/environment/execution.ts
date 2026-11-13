import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Environment } from "."
import { EnvironmentProviders } from "./provider"
import { ExecutionProtocol, type Executor } from "./executor"
import { WorkspaceProtocol } from "../workspace/protocol"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceMounts } from "../workspace/mount"
import { StorageRecovery } from "../storage/recovery"
import { Log } from "../util/log"
import { WorkspaceEvidence } from "../workspace/evidence"
import { EnvironmentExecutionSchema } from "./execution-schema"
import { EnvironmentOrigin } from "./origin"
import { upgradeAccessRecord } from "../migration/import"
import { EnvironmentExecutionOriginIndex } from "./execution-origin-index"
import { EnvironmentUseOwnership } from "./use-ownership"
import { EnvironmentExecutionSource as Sources } from "./execution-source"

export namespace EnvironmentExecution {
  export const Info = EnvironmentExecutionSchema.Info
  export type Info = z.infer<typeof Info>
  export type Checkpoint = (info: Info) => Promise<{
    saved: NonNullable<Info["saved"]>
    checkpointFailures?: Info["checkpointFailures"]
  }>
  interface Pending {
    scopeID: string
    operationID: string
    store: ReturnType<typeof Storage.current>["store"]
    artifactDirectory: string
    artifactObjects: ReturnType<typeof Storage.current>["artifactObjects"]
    origin: EnvironmentOrigin.Captured
    promise: Promise<Info>
  }
  const pending = RuntimeContext.state(() => new Set<Pending>())
  const finishing = Storage.state(() => new Map<string, Promise<Info>>())
  const connections = Storage.state(() => new Map<string, Promise<Executor>>())
  const sourceOperations = Storage.state(
    () => new Map<string, { record: Sources.Record; operations: Sources.Operations }>(),
  )
  interface UseInput {
    id: string
    scopeID: string
    environmentID: string
    origin?: EnvironmentOrigin.Captured
    digest?: string
    intentDigest?: string
    workspaces?: WorkspaceProtocol.Reference[]
  }
  const useOwner = RuntimeContext.state(() => ({
    port: undefined as ReturnType<typeof EnvironmentUseOwnership.register<UseInput>> | undefined,
  }))

  export function hasPendingRequests() {
    return pending().size > 0 || finishing().size > 0 || EnvironmentOrigin.hasRequests() || Sources.hasPendingRequests()
  }

  function currentPending() {
    const current = Storage.current()
    return [...pending()].filter(
      (entry) =>
        entry.store === current.store &&
        entry.artifactDirectory === current.artifactDirectory &&
        entry.artifactObjects === current.artifactObjects,
    )
  }

  export function hasSessionPending(scopeID: string, sessionID: string) {
    if (Sources.hasSessionPending(scopeID, sessionID)) return true
    return (
      EnvironmentOrigin.sessionRequests(scopeID, sessionID).length > 0 ||
      currentPending().some(
        (entry) =>
          entry.origin.value.kind === "session" &&
          entry.origin.value.scopeID === scopeID &&
          entry.origin.value.sessionID === sessionID,
      )
    )
  }

  export const sessionEntries = EnvironmentExecutionOriginIndex.sessionEntries
  export const environmentEntries = EnvironmentExecutionOriginIndex.environmentEntries

  export async function assertSessionDrained(
    scopeID: string,
    sessionID: string,
    environmentID?: string | null,
    workspaceID?: string | null,
  ) {
    if (hasSessionPending(scopeID, sessionID))
      throw new Environment.Busy({ environmentID: "", message: "Environment Session admission is still pending" })
    for await (const info of sessionEntries({ scopeID, sessionID }))
      if (info.state !== "completed")
        throw new Environment.Busy({
          environmentID: info.target.environmentID,
          message: "Environment Session operation requires native receipt and output drainage",
        })
    await Environment.assertSessionUsesDrained({ scopeID, sessionID, environmentID, workspaceID })
    if (environmentID) {
      for await (const info of environmentEntries(environmentID))
        if (info.origin.kind === "legacy-unknown")
          throw new Environment.Busy({
            environmentID,
            message: "Environment has an active legacy operation with unknown Session ownership",
          })
      const selected = await Environment.get(environmentID, scopeID)
      if (!["idle", "ready"].includes(selected.state))
        throw new Environment.Busy({
          environmentID,
          message: "Environment allocation requires its original provider reconciliation",
        })
    }
  }

  export async function drainSession(input: { scopeID: string; sessionID: string; signal: AbortSignal }) {
    const { scopeID, sessionID, signal } = input
    const runtime = RuntimeContext.current()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const assertOwner = () => {
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects
      )
        throw new Error("Environment Session drainage belongs to another Runtime or Storage handle")
      signal.throwIfAborted()
    }
    assertOwner()
    const active = currentPending().filter(
      (entry) =>
        entry.origin.value.kind === "session" &&
        entry.origin.value.scopeID === scopeID &&
        entry.origin.value.sessionID === sessionID,
    )
    const cancelled = Promise.withResolvers<never>()
    const abort = () => cancelled.reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    try {
      await Promise.race([
        Promise.allSettled([
          ...active.map((entry) => entry.promise),
          ...EnvironmentOrigin.sessionRequests(scopeID, sessionID),
        ]),
        cancelled.promise,
      ])
      assertOwner()
      for await (const previous of sessionEntries({ scopeID, sessionID }, signal)) {
        if (previous.state === "completed") continue
        const info = await reconcile(previous.id, previous.scopeID)
        assertOwner()
        if (["exited", "unsaved", "saved"].includes(info.state)) await complete(info.id, info.scopeID)
        assertOwner()
      }
      await assertSessionDrained(scopeID, sessionID)
      assertOwner()
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }

  export function registerRecovery() {
    useOwner().port = EnvironmentUseOwnership.register<UseInput>("execution", {
      capture(value, phase) {
        const input = {
          ...value,
          workspaces: value.workspaces?.map((reference) => WorkspaceProtocol.Reference.parse(reference)),
        }
        input.id = ExecutionProtocol.ID.parse(input.id)
        const origin = input.origin && EnvironmentOrigin.selected(input.origin)
        if (phase === "admission" && (!origin || !input.digest))
          throw new Error("Execution Use admission requires its original native input")
        const ownership =
          phase === "admission" && origin
            ? {
                kind: "execution-preparation" as const,
                scopeID: input.scopeID,
                operationID: input.id,
                origin: origin.value,
              }
            : { kind: "execution" as const, scopeID: input.scopeID, operationID: input.id }
        return {
          selector: {
            scopeID: input.scopeID,
            environmentID: input.environmentID,
            useID: useID(input.scopeID, input.id),
          },
          ownership,
          async verify(target) {
            if (phase === "admission") {
              if (!origin || !input.digest) throw new Error("Execution Use lost its original admission")
              await EnvironmentOrigin.assertAdmission(origin, input)
              return
            }
            if (!target) throw new Error("Execution Use requires its actual allocation target")
            const current = await stored(input.id, input.scopeID)
            if (current.target.environmentID !== input.environmentID || !Environment.sameTarget(current.target, target))
              throw new Error("Execution Use differs from its canonical operation target")
            if (
              (origin && JSON.stringify(current.origin) !== JSON.stringify(origin.value)) ||
              (input.digest !== undefined && current.digest !== input.digest) ||
              (input.intentDigest !== undefined && current.intentDigest !== input.intentDigest) ||
              (input.workspaces !== undefined &&
                JSON.stringify(current.workspaces) !== JSON.stringify(input.workspaces))
            )
              throw new Error("Execution Use differs from its original canonical input")
            if (phase === "release" && !["saved", "completed"].includes(current.state))
              throw new Error("Execution Use requires its original saved native retirement")
          },
        }
      },
      async inspect(ownership, selector, target) {
        if (ownership.kind !== "execution" && ownership.kind !== "execution-preparation")
          throw new Error("Execution Use has another owner")
        if (ownership.kind === "execution-preparation") {
          if (
            ownership.scopeID !== selector.scopeID ||
            useID(ownership.scopeID, ownership.operationID) !== selector.useID ||
            (ownership.origin.kind === "session" && ownership.origin.scopeID !== selector.scopeID)
          )
            throw new Error("Execution Use differs from its original admission")
          return { origin: ownership.origin }
        }
        const info = await stored(ownership.operationID, ownership.scopeID)
        if (
          info.scopeID !== selector.scopeID ||
          useID(info.scopeID, info.id) !== selector.useID ||
          !Environment.sameTarget(info.target, target)
        )
          throw new Error("Execution Use differs from its canonical receipt")
        return { origin: info.origin }
      },
    })
    StorageRecovery.register("environment-execution", recover)
  }

  function uses() {
    const port = useOwner().port
    if (!port) throw new Error("Execution Use owner is unavailable")
    return port
  }

  export async function recover(progress?: () => void) {
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
      progress?.()
    }
  }

  async function stored(id: string, scopeID: string) {
    const key = StoragePath.environmentExecution(scopeID, ExecutionProtocol.ID.parse(id))
    const [record] = await Storage.readMany<unknown>([key])
    if (record === undefined) throw new Storage.NotFoundError({ message: "Environment execution not found" })
    const value = EnvironmentExecutionSchema.Record.parse(upgradeAccessRecord(key, record)).execution
    if (value.id !== id || value.scopeID !== scopeID) throw new Error("Environment execution belongs to another owner")
    return value
  }

  export async function get(id: string, scopeID: string): Promise<Info> {
    return Info.parse(await stored(id, scopeID))
  }

  export function entries(): AsyncIterable<Info> {
    const current = EnvironmentUseOwnership.captureStorage()
    return (async function* () {
      current()
      for await (const row of Storage.records({ prefix: ["environment_execution"], limit: 128 })) {
        current()
        const record = EnvironmentExecutionSchema.Record.parse(upgradeAccessRecord(row.key, row.value))
        const info = record.execution
        if (row.key.length !== 3 || row.key[1] !== info.scopeID || row.key[2] !== info.id)
          throw new Error("Environment execution metadata belongs to another canonical address")
        yield Info.parse(info)
      }
      current()
    })()
  }

  export async function listActive(scopeID: string): Promise<Info[]> {
    const keys = await Storage.list(StoragePath.environmentExecutionActive(scopeID))
    return Promise.all(keys.map((key) => get(key[2], scopeID)))
  }

  export async function start(input: {
    id: string
    scopeID: string
    environmentID: string
    command: ExecutionProtocol.Command
    origin: EnvironmentOrigin.Input
    intentDigest?: string
    workspaces?: WorkspaceProtocol.Reference[]
    signal?: AbortSignal
    source?: Sources.Lease
  }): Promise<Info> {
    const id = ExecutionProtocol.ID.parse(input.id)
    const origin = EnvironmentOrigin.selected(input.origin)
    const workspaces =
      input.workspaces === undefined ? undefined : z.array(WorkspaceProtocol.Reference).parse(input.workspaces)
    input = {
      ...input,
      workspaces,
      command: ExecutionProtocol.Command.parse({ ...input.command, capture: workspaces ?? [] }),
    }
    const digest = ExecutionProtocol.digest(input.command)
    const previous = currentPending().find((entry) => entry.scopeID === input.scopeID && entry.operationID === id)
    if (previous) {
      const info = await previous.promise
      verifyInput(info, input.environmentID, digest, input.workspaces, input.intentDigest, origin.value)
      return info
    }
    const promise = submit({ ...input, id, digest, origin })
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const entry = {
      scopeID: input.scopeID,
      operationID: id,
      store,
      artifactDirectory,
      artifactObjects,
      origin,
      promise,
    }
    pending().add(entry)
    try {
      return await promise
    } finally {
      pending().delete(entry)
    }
  }

  async function submit(input: {
    id: string
    scopeID: string
    environmentID: string
    command: ExecutionProtocol.Command
    origin: EnvironmentOrigin.Captured
    intentDigest?: string
    workspaces?: WorkspaceProtocol.Reference[]
    digest: string
    signal?: AbortSignal
    source?: Sources.Lease
  }) {
    input.origin.assertCurrent()
    const existing = await stored(input.id, input.scopeID).catch((error: unknown) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    input.origin.assertCurrent()
    if (existing) {
      verifyInput(existing, input.environmentID, input.digest, input.workspaces, input.intentDigest, input.origin.value)
      return ["completed", "saved", "unsaved", "exited"].includes(existing.state)
        ? Info.parse(existing)
        : reconcile(input.id, input.scopeID)
    }
    input.signal?.throwIfAborted()
    await EnvironmentOrigin.assertAdmission(input.origin, input)
    await RuntimeMaintenance.assertAdmission()
    input.origin.assertCurrent()
    if (input.source) return submitSource({ ...input, source: input.source })
    const use = await Environment.acquire(input.environmentID, {
      scopeID: input.scopeID,
      useID: useID(input.scopeID, input.id),
      kind: "admission",
      ownership: uses().admission(input),
      capabilities: [input.command.pty ? "pty" : "exec"],
      signal: input.signal,
    })
    let recorded = false
    try {
      const info = await Storage.transaction(
        async () => {
          await RuntimeMaintenance.assertAdmission()
          await EnvironmentOrigin.assertAdmission(input.origin, input)
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
            if (!input.command.useRoots.includes(mount.path))
              throw new Error("Execution must retain its selected Workspace through checkpoint publication")
            const reference = await WorkspaceEvidence.begin(info)
            if (reference) evidence.push({ workspaceID: info.id, reference })
          }
          const now = Date.now()
          const info = Info.parse({
            id: input.id,
            scopeID: input.scopeID,
            origin: input.origin.value,
            target: use.target,
            evidence,
            workspaces: input.workspaces,
            digest: input.digest,
            intentDigest: input.intentDigest,
            state: "submitted",
            outputCursor: 0,
            createdAt: now,
            updatedAt: now,
          })
          await write(info)
          await Environment.retainUse(
            use.target,
            input.scopeID,
            useID(input.scopeID, input.id),
            uses().retention(input),
          )
          return info
        },
        {
          commitGuard() {
            input.origin.assertCurrent()
            input.signal?.throwIfAborted()
          },
        },
      )
      recorded = true
      const executor = await connect(info)
      if (input.signal?.aborted) {
        await cancel(input.id, input.scopeID)
        return get(input.id, input.scopeID)
      }
      try {
        await EnvironmentOrigin.assertAdmission(input.origin, input)
        input.signal?.throwIfAborted()
      } catch (reason) {
        try {
          await cancel(input.id, input.scopeID)
          const cancelled = await get(input.id, input.scopeID)
          if (
            cancelled.status?.state === "cancelled" &&
            cancelled.status.effectsStarted === false &&
            ExecutionProtocol.terminal(cancelled.status)
          )
            await complete(input.id, input.scopeID)
        } catch (error) {
          throw new AggregateError(
            [reason, error],
            "Execution admission closed before dispatch and its native cancellation requires reconciliation",
          )
        }
        throw reason
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
    if (info.state === "completed") return info
    if (info.source) {
      const live = originalSource(info)
      const observed = live ? await live.inspect(id) : (await inspectSource(info)).info
      return observed ? acceptSource(info, observed) : update(info, { state: "unknown" })
    }
    if (["saved", "unsaved", "exited"].includes(info.state)) return info
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
    if (info.source) {
      const live = originalSource(info)
      if (!live)
        throw new Environment.Unavailable({
          environmentID: info.target.environmentID,
          message: "Retained remote execution permits only original receipt inspection",
        })
      await live.cancel(id, info.digest)
      await reconcile(id, scopeID)
      return
    }
    await (await connect(info)).cancel(id, info.digest)
    await reconcile(id, scopeID)
  }

  export async function complete(
    id: string,
    scopeID: string,
    checkpoint: Checkpoint = WorkspaceMounts.checkpointExecution,
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

  async function finish(id: string, scopeID: string, checkpoint: Checkpoint) {
    let info = await stored(id, scopeID)
    if (info.state === "completed") return Info.parse(info)
    if (
      !["exited", "unsaved", "saved"].includes(info.state) ||
      !info.status ||
      !ExecutionProtocol.terminal(info.status)
    )
      throw new Environment.Busy({
        environmentID: info.target.environmentID,
        message: "Physical process and stream completion must be confirmed before saving",
      })
    if (info.source) return finishSource(info)
    const executor = await connect(info)
    if (info.state !== "saved") {
      try {
        await captureOutput(info, executor)
        const result = await checkpoint(info)
        info = await update(info, { state: "saved", ...result })
      } catch (error) {
        await update(info, { state: "unsaved" })
        throw error
      }
    }
    await executor.release(id)
    return Storage.transaction(async () => {
      const latest = await stored(id, scopeID)
      if (latest.state === "completed") return Info.parse(latest)
      await Environment.assertTarget(info.target, scopeID)
      await Environment.releaseUse(
        info.target,
        scopeID,
        useID(scopeID, id),
        uses().retirement({ id, scopeID, environmentID: info.target.environmentID }),
      )
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
    if (info.state !== "completed" && info.state !== "saved") {
      if (info.source)
        return originalSource(info)?.output(id, after, limit) ?? (await inspectSource(info, after, limit)).output
      return (await connect(info)).output(id, after, limit)
    }
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
    data = Uint8Array.from(data)
    const info = await get(id, scopeID)
    if (info.source) {
      const live = originalSource(info)
      if (!live)
        throw new Environment.Unavailable({
          environmentID: info.target.environmentID,
          message: "Retained remote execution cannot send new process input",
        })
      await live.stdin(id, data, end)
      return
    }
    await (await connect(info)).stdin(id, data, end)
  }

  export async function resize(id: string, scopeID: string, cols: number, rows: number) {
    const size = ExecutionProtocol.Command.shape.pty.unwrap().parse({ cols, rows })
    const info = await get(id, scopeID)
    if (info.source) {
      const live = originalSource(info)
      if (!live)
        throw new Environment.Unavailable({
          environmentID: info.target.environmentID,
          message: "Retained remote execution cannot resize a process",
        })
      await live.resize(id, size.cols, size.rows)
      return
    }
    await (await connect(info)).resize(id, size.cols, size.rows)
  }

  export async function connect(info: Pick<Info, "scopeID" | "target" | "source">): Promise<Executor> {
    if (info.source)
      throw new Environment.Unavailable({
        environmentID: info.target.environmentID,
        message: "Remote execution has no controller-local Executor",
      })
    const environment = await Environment.assertTarget(info.target, info.scopeID)
    const provider = EnvironmentProviders.get(environment.provider)
    if (!provider.connect)
      throw new Environment.Unavailable({
        environmentID: environment.id,
        message: "Provider does not expose an Executor",
      })
    const key = JSON.stringify([info.scopeID, info.target, environment.updatedAt])
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

  function originalSource(info: Info) {
    const entry = sourceOperations().get(JSON.stringify([info.scopeID, info.id]))
    if (!entry) return
    if (JSON.stringify(entry.record) !== JSON.stringify(info.source))
      throw new Error("Execution changed its original live source")
    return entry.operations
  }

  async function inspectSource(info: Info, after = 0, limit = 128) {
    if (!info.source) throw new Error("Execution has no retained remote source")
    return Sources.inspect(info.source, {
      scopeID: info.scopeID,
      operationID: info.id,
      digest: info.digest,
      origin: info.origin,
      after,
      limit,
    })
  }

  async function submitSource(input: {
    id: string
    scopeID: string
    environmentID: string
    command: ExecutionProtocol.Command
    origin: EnvironmentOrigin.Captured
    source: Sources.Lease
    digest: string
    intentDigest?: string
    workspaces?: WorkspaceProtocol.Reference[]
    signal?: AbortSignal
  }) {
    const source = Sources.capture(input.source, input.origin),
      owner = Sources.captureOwner(source)
    if (source.target.environmentID !== input.environmentID)
      throw new Environment.Stale({
        environmentID: input.environmentID,
        message: "Execution selected another remote Environment",
      })
    const operations = Sources.operations(input.source)
    const assert = () => {
      owner()
      input.source.assert()
      input.origin.assertCurrent()
      input.signal?.throwIfAborted()
    }
    assert()
    const info = await Storage.transaction(
      async () => {
        await RuntimeMaintenance.assertAdmission()
        await EnvironmentOrigin.assertAdmission(input.origin, { scopeID: input.scopeID })
        assert()
        const now = Date.now()
        return write(
          Info.parse({
            id: input.id,
            scopeID: input.scopeID,
            target: source.target,
            origin: input.origin.value,
            workspaces: input.workspaces,
            digest: input.digest,
            intentDigest: input.intentDigest,
            state: "submitted",
            outputCursor: 0,
            createdAt: now,
            updatedAt: now,
            source,
          }),
        )
      },
      { commitGuard: assert },
    )
    sourceOperations().set(JSON.stringify([info.scopeID, info.id]), { record: source, operations })
    try {
      const observed = await operations.start(input)
      return acceptSource(info, observed)
    } catch (error) {
      await update(info, { state: "unknown" }).catch(() => {})
      throw error
    }
  }

  async function acceptSource(info: Info, observed: Info) {
    if (
      observed.id !== info.id ||
      observed.scopeID !== info.scopeID ||
      observed.digest !== info.digest ||
      !Environment.sameTarget(observed.target, info.target) ||
      JSON.stringify(observed.origin) !== JSON.stringify(info.origin) ||
      observed.sourceObservation === undefined
    )
      throw new Environment.Stale({
        environmentID: info.target.environmentID,
        message: "Remote execution returned another original native operation",
      })
    const status = observed.status && ExecutionProtocol.Status.parse(observed.status)
    if (
      status &&
      (status.id !== info.id || status.digest !== info.digest || !Environment.sameTarget(status.target, info.target))
    )
      throw new Environment.Stale({
        environmentID: info.target.environmentID,
        message: "Remote execution returned another physical receipt",
      })
    const state = ["completed", "saved", "unsaved", "exited"].includes(info.state)
      ? undefined
      : ["completed", "saved", "unsaved", "exited"].includes(observed.state)
        ? "exited"
        : observed.state
    return update(info, { ...(state && { state }), status, sourceObservation: observed.sourceObservation })
  }

  async function finishSource(input: Info) {
    let info = input
    const native = async () => {
      const observation = EnvironmentExecutionSchema.Info.parse(info.sourceObservation)
      if (observation.state === "completed") return observation
      const live = originalSource(info)
      if (!live)
        throw new Environment.Unavailable({
          environmentID: info.target.environmentID,
          message: "Retained remote execution cannot perform a new physical save",
        })
      const observed = await live.complete(info.id)
      info = await acceptSource(info, observed)
      const completed = EnvironmentExecutionSchema.Info.parse(info.sourceObservation)
      if (completed.state !== "completed")
        throw new Environment.Busy({
          environmentID: info.target.environmentID,
          message: "Original remote save and release are not confirmed",
        })
      return completed
    }
    try {
      await captureOutput(info, {
        output: (id, after, limit) =>
          originalSource(info)?.output(id, after, limit) ??
          inspectSource(info, after, limit).then((value) => value.output),
      })
      const completed = await native()
      const result = await update(info, {
        state: "completed",
        saved: completed.saved,
        checkpointFailures: completed.checkpointFailures,
      })
      sourceOperations().delete(JSON.stringify([info.scopeID, info.id]))
      return result
    } catch (error) {
      await update(info, { state: "unsaved" }).catch(() => {})
      throw error
    }
  }

  async function captureOutput(info: Info, executor: Pick<Executor, "output">) {
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
    const state = ExecutionProtocol.terminal(status) ? "exited" : status.state === "unknown" ? "unknown" : "running"
    const unchangedState = info.state === state || (info.state === "cancel_requested" && state === "running")
    if (unchangedState && JSON.stringify(info.status) === JSON.stringify(status)) return info
    return update(info, { status, state })
  }

  function verifyInput(
    info: Info,
    environmentID: string,
    digest: string,
    workspaces: WorkspaceProtocol.Reference[] | undefined,
    intentDigest: string | undefined,
    origin: EnvironmentOrigin.Info,
  ) {
    if (
      JSON.stringify(info.origin) !== JSON.stringify(origin) ||
      info.target.environmentID !== environmentID ||
      (info.intentDigest ? info.intentDigest !== intentDigest : Boolean(intentDigest) || info.digest !== digest) ||
      JSON.stringify((info.workspaces ?? []).map((reference) => WorkspaceProtocol.Reference.parse(reference))) !==
        JSON.stringify(workspaces ?? [])
    )
      throw new Error("Operation ID already has different input")
  }

  async function update(info: Info, changes: Partial<Info>): Promise<Info> {
    const sourceOwner = info.source && Sources.captureOwner(info.source)
    return Storage.transaction(
      async () => {
        if (sourceOwner) sourceOwner()
        else await Environment.assertTarget(info.target, info.scopeID)
        const latest = await stored(info.id, info.scopeID)
        if (!Environment.sameTarget(latest.target, info.target) || latest.digest !== info.digest)
          throw new Environment.Stale({
            environmentID: info.target.environmentID,
            message: "Operation changed during execution",
          })
        if (latest.state === "completed") return Info.parse(latest)
        if (latest.state === "saved" && changes.state && changes.state !== "completed") return Info.parse(latest)
        if (
          ["saved", "unsaved", "exited"].includes(latest.state) &&
          changes.state &&
          ["running", "unknown", "cancel_requested", "exited"].includes(changes.state)
        )
          return Info.parse(latest)
        if (latest.state === "cancel_requested" && changes.state === "running")
          changes = { ...changes, state: "cancel_requested" }
        if (JSON.stringify(latest.source) !== JSON.stringify(info.source))
          throw new Error("Execution changed its retained source")
        if (
          Object.entries(changes).every(
            ([key, value]) => JSON.stringify(latest[key as keyof Info]) === JSON.stringify(value),
          )
        )
          return Info.parse(latest)
        return write({ ...latest, ...changes })
      },
      { commitGuard: sourceOwner },
    )
  }

  async function write(info: Info) {
    const next = EnvironmentExecutionSchema.PersistedInfo.parse({ ...info, updatedAt: Date.now() })
    await EnvironmentOrigin.assertMutation(next.origin)
    const record = EnvironmentExecutionSchema.Record.parse({ schemaVersion: next.source ? 3 : 2, execution: next })
    await Storage.write(StoragePath.environmentExecution(info.scopeID, info.id), record)
    await EnvironmentExecutionOriginIndex.update(next)
    const active = StoragePath.environmentExecutionActive(info.scopeID, info.id)
    if (next.state === "completed") await Storage.remove(active)
    else await Storage.write(active, true)
    return Info.parse(next)
  }

  function useID(scopeID: string, id: string) {
    return JSON.stringify(["execution", scopeID, id])
  }
}
