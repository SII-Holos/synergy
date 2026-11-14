import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { RuntimeIdentity } from "./home"
import type { MemberConnection } from "./connection"
import { OrganizationSyncPath as Keys } from "./storage/path"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

import {
  State,
  Draft,
  Batch,
  ProjectionRecord,
  binding as nativeBinding,
  putDrafts as writeDrafts,
  type Bound,
  type DraftInput,
} from "./sync-outbox"
import { AttachmentRecord, BlobRecord, createSyncProjection } from "./sync-projection"
import {
  pumpNativeSync,
  prepareNativeSync,
  observeNativeSync,
  nativeSyncFaults,
  clearNativeSyncFault,
  observeNativeSyncFailure,
  type NativeSyncFault,
} from "./sync-native-source"

const exporters = RuntimeContext.state(() => new Set<() => Promise<void>>())
export async function drainMemberSync(sessionID: string, preparation?: Epochs.Binding) {
  if (Storage.inTransaction() || !(await Epochs.isFrozen(sessionID)))
    throw new Error("Shared export drainage requires its frozen native source outside a transaction")
  await Promise.all([...exporters()].map((drain) => drain()))
  if (preparation) {
    if (preparation.sessionID !== sessionID) throw new Error("Shared drainage changed its original root")
    await prepareNativeSync(preparation, async () => {
      const source = await Session.get(sessionID)
      if (!source.organization) throw new Error("Shared drainage lacks its original organization binding")
      const original = await nativeBinding(sessionID, source.organization.orgID)
      if (!original) throw new Error("Shared drainage lacks its original native binding")
      await pumpNativeSync(original)
    })
  }
}

const flushDelayMs = 40

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function read<T>(schema: z.ZodType<T>, key: string[]) {
  return Storage.readMany<unknown>([key]).then(([value]) => (value === undefined ? undefined : schema.parse(value)))
}

function errorState(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 256) : "sync exporter failed"
}

export interface MemberSyncExporter {
  flush(): Promise<void>
  close(): Promise<void>
}

export function startMemberSyncExporter(input: {
  identity: RuntimeIdentity
  connection: Pick<MemberConnection, "connected" | "sync" | "syncState" | "uploadBlob"> &
    Partial<Pick<MemberConnection, "observeSync">>
  signal: AbortSignal
}): MemberSyncExporter {
  const { identity, connection, signal } = input
  const originalRuntime = RuntimeContext.current()
  const originalStore = Storage.current().store
  const originalConnection = connection.connected
  const connectionIdentity = JSON.stringify([
    originalConnection.orgID,
    originalConnection.deploymentIncarnation,
    originalConnection.runtimeID,
    originalConnection.connectionEpoch,
  ])
  const sessions = new Set<string>()
  const tails = new Map<string, Promise<void>>()
  const unsubs: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const retryTimer = setInterval(() => {
    if (sessions.size || nativeSyncFaults().length) schedule()
  }, 1_000)
  retryTimer.unref()
  let closed = false
  let running: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const drain = async () => {
    await Promise.allSettled([startup, ...tails.values(), ...(running ? [running] : [])])
  }
  const registeredExporters = exporters()
  registeredExporters.add(drain)

  function queue(sessionID: string, work: () => Promise<void>) {
    if (closed || signal.aborted) return
    const previous = tails.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await work()
      })
      .catch(() => {})
    tails.set(sessionID, next)
    void next.finally(() => {
      if (tails.get(sessionID) === next) tails.delete(sessionID)
    })
  }

  function schedule() {
    if (closed || signal.aborted || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void flush().catch(() => {})
    }, flushDelayMs)
    timer.unref()
  }

  function assertSource() {
    if (
      RuntimeContext.current() !== originalRuntime ||
      Storage.current().store !== originalStore ||
      connection.connected !== originalConnection ||
      connectionIdentity !==
        JSON.stringify([
          connection.connected.orgID,
          connection.connected.deploymentIncarnation,
          connection.connected.runtimeID,
          connection.connected.connectionEpoch,
        ])
    )
      throw new Error("Shared export lost its original Runtime, Store or connection")
  }

  async function sessionBinding(sessionID: string) {
    assertSource()
    const bound = await nativeBinding(sessionID, identity.orgID)
    if (
      !bound ||
      bound.binding.driverRuntimeID !== connection.connected.runtimeID ||
      (await Epochs.isFrozen(bound.rootSessionID))
    )
      return
    return bound
  }
  async function assertBinding(original: Bound) {
    const current = await sessionBinding(original.session.id)
    if (
      !current ||
      current.session.scope.id !== original.session.scope.id ||
      current.root.scope.id !== original.root.scope.id ||
      current.rootSessionID !== original.rootSessionID ||
      JSON.stringify(current.binding) !== JSON.stringify(original.binding)
    )
      throw new Error("Shared export lost its original native Session binding")
    return current
  }
  async function putDrafts(rootSessionID: string, inputs: DraftInput[], original?: Bound) {
    const bound = original ?? (await sessionBinding(rootSessionID))
    if (!bound) return
    if (bound.rootSessionID !== rootSessionID) throw new Error("Shared events changed their original native root")
    await writeDrafts(bound, inputs, {
      async check() {
        await assertBinding(bound)
      },
      assertCurrent: assertSource,
      afterFailure(error) {
        observeNativeSyncFailure(bound, error)
      },
    })
    sessions.add(rootSessionID)
    schedule()
  }
  const projection = createSyncProjection({
    orgID: identity.orgID,
    binding: sessionBinding,
    putDrafts,
    async write(bound, key, value) {
      await Storage.transaction(
        async () => {
          Storage.afterFailure((error) => {
            observeNativeSyncFailure(bound, error)
          })
          await assertBinding(bound)
          await Storage.write(key, value)
        },
        { commitGuard: assertSource },
      )
    },
    waitForChild: (sessionID) => tails.get(sessionID),
  })
  const { ensureSession, projectPart, projectMessage } = projection
  function observeSession(sessionID: string) {
    queue(sessionID, () => projection.projectSession(sessionID))
  }
  function observeAttachment(part: MessageV2.AttachmentPart) {
    queue(part.sessionID, () => projection.projectAttachment(part))
  }
  async function proveLocalRecovery(bound: Bound) {
    await assertBinding(bound)
    await ensureSession(bound.rootSessionID)
    await Storage.transaction(
      async () => {
        Storage.afterFailure((error) => {
          observeNativeSyncFailure(bound, error)
        })
        await assertBinding(bound)
        const key = Keys.state(identity.orgID, bound.rootSessionID)
        const current = await read(State, key)
        if (!current) throw new Error("Storage recovery lacks its original durable outbox state")
        await Storage.write(key, State.parse({ ...current, syncState: "pending", updatedAt: Date.now() }))
        await assertBinding(bound)
      },
      { commitGuard: assertSource },
    )
  }

  async function storageObservation(sessionID: string, fault: NativeSyncFault, recovered: boolean) {
    const bound = await sessionBinding(sessionID)
    if (!bound || JSON.stringify(bound.binding) !== JSON.stringify(fault.binding))
      throw new Error("Storage observation changed its original native Session binding")
    assertSource()
    if (connection.connected.syncVersion !== Sync.observationVersion || !connection.observeSync)
      throw new Error("Storage observation requires the original negotiated sync owner")
    let share = await connection.syncState(sessionID, signal)
    await assertBinding(bound)
    if (share.shareState !== "shared") return
    const tuple = {
      bindingEpoch: bound.binding.bindingEpoch,
      shareGeneration: share.shareGeneration,
      nextSeq: share.nextSeq,
    }
    if (share.bindingEpoch !== tuple.bindingEpoch) throw new Error("Storage observation changed its original epoch")
    if (share.syncState !== "blocked") {
      share = await connection.observeSync(sessionID, { ...tuple, state: "blocked", reason: "storage_full" }, signal)
      await assertBinding(bound)
      if (
        share.syncState !== "blocked" ||
        share.bindingEpoch !== tuple.bindingEpoch ||
        share.shareGeneration !== tuple.shareGeneration ||
        share.nextSeq !== tuple.nextSeq
      )
        throw new Error("Storage blockage lacks its original acknowledgement")
    }
    if (!recovered) return
    await proveLocalRecovery(bound)
    share = await connection.observeSync(sessionID, { ...tuple, state: "pending" }, signal)
    await assertBinding(bound)
    if (
      share.syncState !== "pending" ||
      share.bindingEpoch !== tuple.bindingEpoch ||
      share.shareGeneration !== tuple.shareGeneration ||
      share.nextSeq !== tuple.nextSeq
    )
      throw new Error("Storage recovery lacks its original pending acknowledgement")
    if (!clearNativeSyncFault(fault)) throw new Error("Storage recovery retains a newer original write failure")
  }

  async function uploadBatchBlobs(rootSessionID: string, share: Sync.Share, batch: Sync.Batch) {
    const events = batch.events.filter(
      (event): event is Extract<Sync.Event, { type: "attachment" | "blob" }> =>
        (event.type === "attachment" || event.type === "blob") && event.state === "available",
    )
    const uploaded = new Set<string>()
    for (const event of events) {
      const sourceSessionID = event.sessionID ?? rootSessionID
      const blobID = event.type === "attachment" ? event.attachmentID : event.blobID
      if (uploaded.has(blobID)) continue
      uploaded.add(blobID)
      const record =
        event.type === "attachment"
          ? await read(
              AttachmentRecord,
              Keys.attachmentContent(identity.orgID, sourceSessionID, event.attachmentID, event.hash, event.bytes),
            )
          : await read(BlobRecord, Keys.blob(identity.orgID, sourceSessionID, event.blobID))
      if (!record || record.artifact.status !== "complete" || !record.artifact.sha256) continue
      const artifact = record.artifact
      const hashValue = artifact.sha256
      if (!hashValue || artifact.bytes !== event.bytes || hashValue !== event.hash)
        throw new Error("Attachment metadata changed")
      const hash = Protocol.Digest.parse(hashValue)
      const artifactOwner =
        "scopeID" in record
          ? ({ kind: "session", scopeID: record.scopeID, sessionID: sourceSessionID } as const)
          : record.owner
      if (artifact.bytes === 0) {
        if (!(await sessionBinding(rootSessionID))) return
        await connection.uploadBlob(
          {
            sessionID: rootSessionID,
            shareGeneration: share.shareGeneration,
            hash,
            offset: 0,
            totalBytes: 0,
            bytes: new Uint8Array(),
          },
          signal,
        )
        continue
      }
      const parts: Uint8Array[] = []
      let buffered = 0
      let offset = 0
      async function send() {
        if (!buffered) return
        if (!(await sessionBinding(rootSessionID))) throw new Error("Shared export source epoch is frozen")
        const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)))
        await connection.uploadBlob(
          {
            sessionID: rootSessionID,
            shareGeneration: share.shareGeneration,
            hash,
            offset,
            totalBytes: artifact.bytes,
            bytes,
          },
          signal,
        )
        offset += bytes.byteLength
        parts.length = 0
        buffered = 0
      }
      for await (const part of RolloutArtifact.read(artifactOwner, artifact)) {
        parts.push(part)
        buffered += part.byteLength
        if (buffered === 4 * 1024 * 1024) await send()
      }
      await send()
    }
  }

  async function prepareGeneration(rootSessionID: string, share: Sync.Share) {
    const current = await read(State, Keys.state(identity.orgID, rootSessionID))
    if (current?.shareGeneration === share.shareGeneration && current.projectionVersion === 2) return
    const captured = await sessionBinding(rootSessionID)
    if (!captured) return
    const bound = captured
    if (bound.binding.bindingEpoch !== share.bindingEpoch)
      throw new Error("Shared export generation changed its original native binding epoch")
    const pending = [rootSessionID]
    const visited = new Set<string>()
    while (pending.length) {
      if (closed || signal.aborted) return
      signal.throwIfAborted()
      const sessionID = pending.shift()!
      if (!visited.add(sessionID) || !(await sessionBinding(sessionID))) continue
      await ensureSession(sessionID)
      for await (const message of MessageV2.stream({ sessionID })) {
        if (closed || signal.aborted) return
        queue(sessionID, () => projectMessage(message.info))
        await tails.get(sessionID)
        for (const part of message.parts) {
          await projectPart(part)
          if (part.type === "attachment") observeAttachment(part)
          if (part.type === "tool" && part.state.status === "completed")
            for (const attachment of part.state.attachments ?? []) observeAttachment(attachment)
        }
        await tails.get(sessionID)
      }
      observeSession(sessionID)
      await tails.get(sessionID)
      pending.push(...(await Session.children(sessionID)).map((child) => child.id))
    }
    async function requeueProjections(keys: string[][]) {
      await assertBinding(bound)
      const values = await Storage.readMany<unknown>(keys)
      const projections = values.flatMap((value, index) => {
        if (value === undefined) return []
        const projection = ProjectionRecord.parse(value)
        if (
          JSON.stringify(keys[index]) !==
          JSON.stringify(Keys.projection(identity.orgID, rootSessionID, projection.draftID))
        )
          throw new Error("Shared projection belongs to another native draft")
        return [projection]
      })
      const drafts = await Storage.readMany<unknown>(
        projections.map((projection) => Keys.draft(identity.orgID, rootSessionID, projection.draftID)),
      )
      const orders = await Storage.readMany<unknown>(
        projections.map((projection, index) =>
          Keys.orderedDraft(
            identity.orgID,
            rootSessionID,
            drafts[index] === undefined ? projection.localSequence : Draft.parse(drafts[index]).localSequence,
          ),
        ),
      )
      const changed = projections.filter((projection, index) => {
        const previous = drafts[index] === undefined ? undefined : Draft.parse(drafts[index])
        const order =
          orders[index] === undefined ? undefined : z.strictObject({ draftID: Identity.ID }).parse(orders[index])
        return (
          !previous ||
          previous.draftID !== projection.draftID ||
          previous.sessionID !== rootSessionID ||
          previous.bytes !== Buffer.byteLength(JSON.stringify(projection.event)) ||
          JSON.stringify(previous.event) !== JSON.stringify(projection.event) ||
          order?.draftID !== projection.draftID
        )
      })
      await assertBinding(bound)
      if (!changed.length) return
      await Storage.transaction(
        async () => {
          await assertBinding(bound)
          for (const captured of changed) {
            const projection = await read(
              ProjectionRecord,
              Keys.projection(identity.orgID, rootSessionID, captured.draftID),
            )
            if (!projection) continue
            const draftKey = Keys.draft(identity.orgID, rootSessionID, projection.draftID)
            const previous = await read(Draft, draftKey)
            const localSequence = previous?.localSequence ?? projection.localSequence
            const event = Sync.Event.parse({ ...projection.event, sequence: 1 })
            await Storage.write(
              draftKey,
              Draft.parse({
                schemaVersion: 1,
                draftID: projection.draftID,
                sessionID: rootSessionID,
                localSequence,
                event,
                queuedAt: previous?.queuedAt ?? Date.now(),
                bytes: Buffer.byteLength(JSON.stringify(event)),
              }),
            )
            await Storage.write(Keys.orderedDraft(identity.orgID, rootSessionID, localSequence), {
              draftID: projection.draftID,
            })
          }
        },
        {
          commitGuard: () => {
            assertSource()
          },
        },
      )
    }
    let window: string[][] = []
    for await (const row of Storage.records<unknown>({
      prefix: Keys.projections(identity.orgID, rootSessionID),
      limit: 128,
    })) {
      if (closed || signal.aborted) return
      window.push(row.key)
      if (window.length < 128) continue
      await requeueProjections(window)
      window = []
    }
    if (window.length) await requeueProjections(window)
    await Storage.transaction(
      async () => {
        await assertBinding(bound)
        const latest = await read(State, Keys.state(identity.orgID, rootSessionID))
        await Storage.write(
          Keys.state(identity.orgID, rootSessionID),
          State.parse({
            schemaVersion: 1,
            orgID: identity.orgID,
            sessionID: rootSessionID,
            nextDraft: latest?.nextDraft ?? 1,
            shareGeneration: share.shareGeneration,
            syncState: "pending",
            projectionVersion: 2,
            updatedAt: Date.now(),
          }),
        )
      },
      {
        commitGuard: () => {
          assertSource()
        },
      },
    )
    sessions.add(rootSessionID)
    schedule()
  }

  async function prepare(sessionID: string, share: Sync.Share) {
    const batchKey = Keys.batch(identity.orgID, sessionID)
    const stored = await read(Batch, batchKey)
    if (stored && stored.shareGeneration === share.shareGeneration && stored.bindingEpoch === share.bindingEpoch) {
      const bound = await sessionBinding(sessionID)
      if (!bound) return
      return Sync.Batch.parse({
        schemaVersion: 1,
        sessionID: stored.sessionID,
        projectID: bound.binding.projectID,
        bindingEpoch: stored.bindingEpoch,
        shareGeneration: stored.shareGeneration,
        firstSeq: stored.firstSeq,
        lastSeq: stored.lastSeq,
        payloadHash: stored.payloadHash,
        events: stored.events,
      })
    }
    if (stored) await Storage.remove(batchKey)
    const rows = await Storage.query({ prefix: Keys.orderedDrafts(identity.orgID, sessionID), limit: 256 })
    const candidates = await Promise.all(
      rows.map(async (row) => {
        const index = z.strictObject({ draftID: Identity.ID }).parse(row.value)
        const draft = await read(Draft, Keys.draft(identity.orgID, sessionID, index.draftID))
        if (!draft) throw new Error("Pending sync order has no matching draft")
        return draft
      }),
    )
    const drafts: Draft[] = []
    let bytes = 1024
    for (const candidate of candidates) {
      if (drafts.length && bytes + candidate.bytes + 128 > 1024 * 1024) break
      drafts.push(candidate)
      bytes += candidate.bytes + 128
    }
    if (!drafts.length) return
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    const events = drafts.map((draft, index) => {
      const event = { ...draft.event, sequence: share.nextSeq + index }
      if (event.type === "session") event.session = { ...event.session, shareGeneration: share.shareGeneration }
      return Sync.Event.parse(event)
    })
    const firstSeq = events[0]!.sequence
    const lastSeq = events.at(-1)!.sequence
    const hash = digest({ firstSeq, lastSeq, events })
    const persisted = Batch.parse({
      schemaVersion: 1,
      sessionID,
      bindingEpoch: share.bindingEpoch,
      shareGeneration: share.shareGeneration,
      firstSeq,
      lastSeq,
      payloadHash: hash,
      draftIDs: drafts.map((draft) => draft.draftID),
      draftHashes: drafts.map((draft) => digest(draft.event)),
      events,
    })
    await Storage.write(batchKey, persisted)
    return Sync.Batch.parse({
      schemaVersion: 1,
      sessionID,
      projectID: bound.binding.projectID,
      bindingEpoch: persisted.bindingEpoch,
      shareGeneration: persisted.shareGeneration,
      firstSeq,
      lastSeq,
      payloadHash: persisted.payloadHash,
      events,
    })
  }

  async function flushSession(sessionID: string) {
    const original = await sessionBinding(sessionID)
    if (!original) return
    const fault = nativeSyncFaults().find((value) => value.rootSessionID === sessionID)
    if (fault) await storageObservation(sessionID, fault, true)
    let share = await connection.syncState(sessionID, signal)
    if (share.shareState !== "shared") return
    if (share.syncState === "blocked") {
      if (connection.connected.syncVersion !== Sync.observationVersion || !connection.observeSync) return
      await proveLocalRecovery(original)
      const tuple = {
        bindingEpoch: original.binding.bindingEpoch,
        shareGeneration: share.shareGeneration,
        nextSeq: share.nextSeq,
      }
      share = await connection.observeSync(sessionID, { ...tuple, state: "pending" }, signal)
      await assertBinding(original)
      if (
        share.syncState !== "pending" ||
        share.bindingEpoch !== tuple.bindingEpoch ||
        share.shareGeneration !== tuple.shareGeneration ||
        share.nextSeq !== tuple.nextSeq
      )
        throw new Error("Cold storage recovery lacks its original pending acknowledgement")
      if (nativeSyncFaults().some((value) => value.rootSessionID === sessionID))
        throw new Error("Cold storage recovery retains a newer original write failure")
    }
    await prepareGeneration(sessionID, share)
    if (closed || signal.aborted) return
    const batch = await prepare(sessionID, share)
    if (!batch) return
    await uploadBatchBlobs(sessionID, share, batch)
    const bound = await sessionBinding(sessionID)
    if (!bound || bound.binding.bindingEpoch !== batch.bindingEpoch) return
    const ack = Sync.Ack.parse(await connection.sync(batch, signal))
    if (
      ack.sessionID !== batch.sessionID ||
      ack.shareGeneration !== batch.shareGeneration ||
      ack.bindingEpoch !== batch.bindingEpoch ||
      ack.nextSeq < batch.lastSeq + 1
    )
      throw new Error("Runtime sync acknowledgement does not match the sent batch")
    const stored = await read(Batch, Keys.batch(identity.orgID, sessionID))
    if (!stored || stored.payloadHash !== batch.payloadHash) return
    await Storage.transaction(async () => {
      await Storage.remove(Keys.batch(identity.orgID, sessionID))
      for (const [index, draftID] of stored.draftIDs.entries()) {
        const draftKey = Keys.draft(identity.orgID, sessionID, draftID)
        const draft = await read(Draft, draftKey)
        if (!draft || stored.draftHashes?.[index] !== digest(draft.event)) continue
        await Storage.remove(draftKey)
        await Storage.remove(Keys.orderedDraft(identity.orgID, sessionID, draft.localSequence))
      }
      const current = await read(State, Keys.state(identity.orgID, sessionID))
      await Storage.write(
        Keys.state(identity.orgID, sessionID),
        State.parse({
          schemaVersion: 1,
          orgID: identity.orgID,
          sessionID,
          nextDraft: current?.nextDraft ?? 1,
          shareGeneration: current?.shareGeneration,
          syncState: ack.syncState,
          projectionVersion: current?.projectionVersion,
          updatedAt: Date.now(),
        }),
      )
    })
  }

  async function flush() {
    if (running || closed || signal.aborted) return running
    running = (async () => {
      await startup
      await Promise.all([...tails.values()])
      const failures: unknown[] = []
      for (const sessionID of new Set([...sessions, ...nativeSyncFaults().map((value) => value.rootSessionID)])) {
        if (closed || signal.aborted) return
        try {
          const original = await sessionBinding(sessionID)
          if (original) await pumpNativeSync(original)
        } catch (error) {
          const fault = nativeSyncFaults().find((value) => value.rootSessionID === sessionID)
          if (fault) await storageObservation(sessionID, fault, false).catch(() => {})
          failures.push(error)
          continue
        }
        try {
          await flushSession(sessionID)
        } catch (error) {
          if (closed || signal.aborted) return
          const original = await nativeBinding(sessionID, identity.orgID)
          if (original) observeNativeSyncFailure(original, error)
          const fault = nativeSyncFaults().find((value) => value.rootSessionID === sessionID)
          if (fault) await storageObservation(sessionID, fault, false).catch(() => {})
          const current = await read(State, Keys.state(identity.orgID, sessionID))
          await Storage.write(
            Keys.state(identity.orgID, sessionID),
            State.parse({
              schemaVersion: 1,
              orgID: identity.orgID,
              sessionID,
              nextDraft: current?.nextDraft ?? 1,
              shareGeneration: current?.shareGeneration,
              syncState: "failed",
              projectionVersion: current?.projectionVersion,
              updatedAt: Date.now(),
            }),
          ).catch(() => {})
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, "Native shared deliveries remain unaccepted")
    })().finally(() => {
      running = undefined
    })
    return running
  }

  unsubs.push(
    observeNativeSync((rootSessionID) => {
      if (closed || signal.aborted) return
      sessions.add(rootSessionID)
      queue(rootSessionID, async () => {
        const original = await sessionBinding(rootSessionID)
        if (original) await pumpNativeSync(original)
      })
      schedule()
    }),
  )
  unsubs.push(
    Bus.subscribeGlobal(SessionEvent.Status, (event) => {
      queue(event.properties.sessionID, async () => {
        await projection.projectSession(event.properties.sessionID)
      })
    }),
  )
  const startup = (async () => {
    for await (const row of Storage.records<unknown>({ prefix: Keys.roots(identity.orgID), limit: 256 })) {
      if (closed || signal.aborted) return
      sessions.add(z.strictObject({ sessionID: Identity.ID }).parse(row.value).sessionID)
    }
    schedule()
  })()
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()

  function onAbort() {
    void close().catch(() => {})
  }

  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    clearTimeout(timer)
    clearInterval(retryTimer)
    for (const unsubscribe of unsubs) unsubscribe()
    signal.removeEventListener("abort", onAbort)
    closing = (async () => {
      const settled = await Promise.allSettled([startup, ...tails.values(), ...(running ? [running] : [])])
      const local = await Promise.allSettled(
        [...sessions].map(async (sessionID) => {
          const original = await nativeBinding(sessionID, identity.orgID)
          if (original && !(await Epochs.isFrozen(original.rootSessionID))) await pumpNativeSync(original)
        }),
      )
      settled.push(...local)
      tails.clear()
      sessions.clear()
      registeredExporters.delete(drain)
      const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Shared transcript exporter cleanup failed")
    })()
    return closing
  }

  return {
    flush: async () => {
      await flush()
    },
    close,
  }
}
