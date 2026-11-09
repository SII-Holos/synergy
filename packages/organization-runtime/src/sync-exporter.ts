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
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { MemberIdentity } from "./home"
import type { MemberConnection } from "./connection"
import { OrganizationSyncPath as Keys } from "./storage/path"

const State = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  sessionID: Identity.ID,
  nextDraft: Identity.Revision,
  shareGeneration: Identity.Revision.optional(),
  syncState: Sync.SyncState,
  updatedAt: z.number().int().nonnegative(),
})
type State = z.infer<typeof State>

const Draft = z.strictObject({
  schemaVersion: z.literal(1),
  draftID: Identity.ID,
  sessionID: Identity.ID,
  localSequence: Identity.Revision,
  event: Sync.Event,
  queuedAt: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
type Draft = z.infer<typeof Draft>

const ProjectionRecord = z.strictObject({
  schemaVersion: z.literal(1),
  draftID: Identity.ID,
  localSequence: Identity.Revision,
  event: Sync.Event,
})
type ProjectionRecord = z.infer<typeof ProjectionRecord>

const AttachmentRecord = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  attachmentID: Identity.ID,
  scopeID: z.string().min(1),
  artifact: RolloutArtifact.Ref,
})
type AttachmentRecord = z.infer<typeof AttachmentRecord>

const BlobRecord = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  owner: RolloutArtifact.Owner,
  artifact: RolloutArtifact.Ref,
})
type BlobRecord = z.infer<typeof BlobRecord>

const Batch = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  bindingEpoch: Protocol.Epoch,
  shareGeneration: Identity.Revision,
  firstSeq: Sync.Sequence,
  lastSeq: Sync.Sequence,
  payloadHash: Protocol.Digest,
  draftIDs: z.array(Identity.ID).min(1).max(256),
  events: z.array(Sync.Event).min(1).max(256),
})
type Batch = z.infer<typeof Batch>

const flushDelayMs = 40

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function safeSummary(value: string | undefined, limit = 32 * 1024) {
  return value?.slice(0, limit) ?? ""
}

function read<T>(schema: z.ZodType<T>, key: string[]) {
  return Storage.readMany<unknown>([key]).then(([value]) => (value === undefined ? undefined : schema.parse(value)))
}

function errorState(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 256) : "sync exporter failed"
}

export interface MemberSyncExporter {
  flush(): Promise<void>
  close(): void
}

export function startMemberSyncExporter(input: {
  identity: MemberIdentity
  connection: MemberConnection
  signal: AbortSignal
}): MemberSyncExporter {
  const { identity, connection, signal } = input
  const sessions = new Set<string>()
  const tails = new Map<string, Promise<void>>()
  const unsubs: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const retryTimer = setInterval(() => {
    if (sessions.size) schedule()
  }, 1_000)
  retryTimer.unref()
  let closed = false
  let running: Promise<void> | undefined

  function queue(sessionID: string, work: () => Promise<void>) {
    const previous = tails.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (closed || signal.aborted) return
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
      void flush()
    }, flushDelayMs)
    timer.unref()
  }

  async function sessionBinding(sessionID: string) {
    const initial = await Session.get(sessionID).catch(() => undefined)
    if (!initial) return
    const chain: Session.Info[] = []
    const visited = new Set<string>()
    let current = initial
    while (true) {
      if (!visited.add(current.id)) return
      chain.push(current)
      if (!current.parentID) break
      if (!current.cortex || current.cortex.parentSessionID !== current.parentID) return
      const parent = await Session.get(current.parentID).catch(() => undefined)
      if (!parent) return
      current = parent
    }
    const root = chain.at(-1)!
    const binding = root.organization
    if (
      !binding ||
      binding.orgID !== identity.orgID ||
      binding.driverRuntimeID !== connection.connected.runtimeID ||
      binding.projectID !== root.scope.id ||
      chain.some(
        (entry) =>
          entry.organization?.orgID !== binding.orgID ||
          entry.organization?.projectID !== binding.projectID ||
          entry.organization?.creatorID !== binding.creatorID ||
          entry.organization?.driverRuntimeID !== binding.driverRuntimeID ||
          entry.organization?.bindingEpoch !== binding.bindingEpoch ||
          entry.scope.id !== binding.projectID,
      )
    )
      return
    return {
      session: initial,
      root,
      binding,
      rootSessionID: root.id,
      parentSessionID: initial.parentID,
    }
  }

  async function putDraft(rootSessionID: string, draftID: string, event: Sync.Event) {
    const bound = await sessionBinding(rootSessionID)
    if (!bound) return
    const draftKey = Keys.draft(identity.orgID, rootSessionID, draftID)
    await Storage.transaction(async () => {
      const current = await read(State, Keys.state(identity.orgID, rootSessionID))
      const previous = await read(Draft, draftKey)
      const retained =
        previous ?? (await read(ProjectionRecord, Keys.projection(identity.orgID, rootSessionID, draftID)))
      const bytes = Buffer.byteLength(JSON.stringify(event))
      const localSequence = retained?.localSequence ?? current?.nextDraft ?? 1
      const nextDraft = retained ? (current?.nextDraft ?? localSequence) : localSequence + 1
      await Storage.write(
        draftKey,
        Draft.parse({
          schemaVersion: 1,
          draftID,
          sessionID: rootSessionID,
          localSequence,
          event: Sync.Event.parse({ ...event, sequence: 1 }),
          queuedAt: previous?.queuedAt ?? Date.now(),
          bytes,
        }),
      )
      await Storage.write(
        Keys.projection(identity.orgID, rootSessionID, draftID),
        ProjectionRecord.parse({
          schemaVersion: 1,
          draftID,
          localSequence,
          event: Sync.Event.parse({ ...event, sequence: 1 }),
        }),
      )
      await Storage.write(
        Keys.state(identity.orgID, rootSessionID),
        State.parse({
          schemaVersion: 1,
          orgID: identity.orgID,
          sessionID: rootSessionID,
          nextDraft,
          shareGeneration: current?.shareGeneration,
          syncState: current?.syncState === "failed" ? "pending" : (current?.syncState ?? "pending"),
          updatedAt: Date.now(),
        }),
      )
    })
    sessions.add(rootSessionID)
    schedule()
  }

  async function ensureSession(sessionID: string) {
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    if (bound.parentSessionID) await ensureSession(bound.parentSessionID)
    if (bound.rootSessionID !== sessionID) await ensureSession(bound.rootSessionID)
    const { session, binding, rootSessionID, parentSessionID } = bound
    const draftID = digest({ type: "session", sessionID }).slice(0, 32)
    await putDraft(
      rootSessionID,
      draftID,
      Sync.Event.parse({
        type: "session",
        sequence: 1,
        session: {
          sessionID,
          projectID: binding.projectID,
          creatorID: binding.creatorID,
          driverRuntimeID: binding.driverRuntimeID,
          bindingEpoch: binding.bindingEpoch,
          createdAt: session.time.created,
          shareGeneration: 0,
          ...(rootSessionID === sessionID
            ? {}
            : {
                rootSessionID,
                parentSessionID,
                cortex: session.cortex && {
                  taskID: session.cortex.taskID,
                  parentSessionID: session.cortex.parentSessionID,
                  parentMessageID: session.cortex.parentMessageID,
                  status: session.cortex.status,
                  description: safeSummary(session.cortex.description, 512),
                  startedAt: session.cortex.startedAt,
                  completedAt: session.cortex.completedAt,
                  notifyParentOnComplete: session.cortex.notifyParentOnComplete,
                  visibility: session.cortex.visibility,
                },
              }),
        },
      }),
    )
  }

  async function rememberAttachment(sessionID: string, part: MessageV2.AttachmentPart) {
    const artifact = part.artifact
    if (!artifact) return
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    await Storage.write(
      Keys.attachment(identity.orgID, sessionID, part.id),
      AttachmentRecord.parse({
        schemaVersion: 1,
        sessionID,
        attachmentID: part.id,
        scopeID: bound.session.scope.id,
        artifact,
      }),
    )
  }

  async function rememberBlob(sessionID: string, owner: RolloutArtifact.Owner, artifact: RolloutArtifact.Ref) {
    if (artifact.status !== "complete" || !artifact.sha256) return
    await Storage.write(
      Keys.blob(identity.orgID, sessionID, artifact.id),
      BlobRecord.parse({ schemaVersion: 1, sessionID, owner, artifact }),
    )
  }

  function observeSession(sessionID: string) {
    queue(sessionID, async () => {
      const bound = await sessionBinding(sessionID)
      if (!bound) return
      await ensureSession(sessionID)
      if (!bound.session.cortex) return
      const cortex = bound.session.cortex
      const summary = safeSummary(cortex.error ?? (typeof cortex.output?.value === "string" ? cortex.output.value : ""))
      const safe = {
        sessionID,
        taskID: cortex.taskID,
        status: cortex.status,
        description: safeSummary(cortex.description, 512),
        completedAt: cortex.completedAt,
        summary,
      }
      await putDraft(
        bound.rootSessionID,
        digest({ type: "cortex", sessionID, taskID: cortex.taskID }).slice(0, 32),
        Sync.Event.parse({
          type: "cortex",
          sequence: 1,
          sessionID,
          taskID: cortex.taskID,
          parentSessionID: cortex.parentSessionID,
          parentMessageID: cortex.parentMessageID,
          status: cortex.status,
          description: safeSummary(cortex.description, 512),
          startedAt: cortex.startedAt,
          completedAt: cortex.completedAt,
          notifyParentOnComplete: cortex.notifyParentOnComplete,
          deliveryNotifiedAt: cortex.deliveryNotifiedAt,
          summary,
          integrity: digest(safe),
        }),
      )
    })
  }

  function observeMessage(info: MessageV2.Info) {
    queue(info.sessionID, async () => {
      const bound = await sessionBinding(info.sessionID)
      if (!bound) return
      await ensureSession(info.sessionID)
      const summary =
        info.role === "user"
          ? safeSummary(info.summary?.body ?? info.summary?.title)
          : safeSummary(info.error?.name ?? info.finish)
      const safe = { messageID: info.id, role: info.role, createdAt: info.time.created, summary }
      await putDraft(
        bound.rootSessionID,
        digest({ type: "message", sessionID: info.sessionID, messageID: info.id }).slice(0, 32),
        Sync.Event.parse({
          type: "message",
          sequence: 1,
          ...(info.sessionID === bound.rootSessionID ? {} : { sessionID: info.sessionID }),
          messageID: info.id,
          role: info.role,
          createdAt: info.time.created,
          summary,
          integrity: digest(safe),
        }),
      )
    })
  }

  function observeTool(event: { sessionID: string; record: RolloutEvents.Record }) {
    if (event.record.kind !== "tool" || event.record.value.owner.kind !== "session") return
    const tool = event.record.value
    const status =
      tool.status === "completed"
        ? "completed"
        : tool.status === "failed"
          ? "error"
          : tool.status === "cancelled" || tool.status === "interrupted"
            ? "unknown"
            : "running"
    queue(event.sessionID, async () => {
      const bound = await sessionBinding(event.sessionID)
      if (!bound) return
      await ensureSession(event.sessionID)
      const safe = { callID: tool.toolCallID, name: tool.tool, state: status }
      await putDraft(
        bound.rootSessionID,
        digest({ type: "tool", sessionID: event.sessionID, callID: tool.toolCallID }).slice(0, 32),
        Sync.Event.parse({
          type: "tool",
          sequence: 1,
          ...(event.sessionID === bound.rootSessionID ? {} : { sessionID: event.sessionID }),
          callID: tool.toolCallID,
          name: tool.tool,
          state: status,
          summary: "",
          integrity: digest(safe),
        }),
      )
      const owner = tool.owner
      const outputs = [["tool-output", tool.rawResult] as const, ["tool-observation", tool.observation] as const]
      for (const [kind, artifact] of outputs) {
        if (!artifact?.sha256 || artifact.status !== "complete") continue
        await rememberBlob(event.sessionID, owner, artifact)
        await putDraft(
          bound.rootSessionID,
          digest({ type: "blob", sessionID: event.sessionID, blobID: artifact.id, kind }).slice(0, 32),
          Sync.Event.parse({
            type: "blob",
            sequence: 1,
            ...(event.sessionID === bound.rootSessionID ? {} : { sessionID: event.sessionID }),
            blobID: artifact.id,
            kind,
            mediaType: artifact.mediaType.slice(0, 256) || "application/octet-stream",
            bytes: artifact.bytes,
            hash: artifact.sha256,
            state: "available",
          }),
        )
      }
    })
  }

  function observeAttachment(part: MessageV2.AttachmentPart) {
    const artifact = part.artifact
    if (!artifact?.sha256 || !Protocol.Digest.safeParse(artifact.sha256).success) return
    const filename = (part.filename ?? "attachment").split(/[\\/]/).at(-1) || "attachment"
    const attachment = Sync.Event.parse({
      type: "attachment",
      sequence: 1,
      sessionID: part.sessionID,
      attachmentID: part.id,
      filename: filename.slice(0, 512),
      mediaType: part.mime.slice(0, 256) || "application/octet-stream",
      bytes: artifact.bytes,
      hash: artifact.sha256,
      state: artifact.status === "complete" ? "available" : "uploading",
    })
    queue(part.sessionID, async () => {
      const bound = await sessionBinding(part.sessionID)
      if (!bound) return
      await ensureSession(part.sessionID)
      await rememberAttachment(part.sessionID, part)
      await putDraft(
        bound.rootSessionID,
        digest({ type: "attachment", sessionID: part.sessionID, attachmentID: part.id }).slice(0, 32),
        attachment,
      )
    })
  }

  async function observeNotification(sessionID: string, items: SessionInbox.Item[]) {
    queue(sessionID, async () => {
      const bound = await sessionBinding(sessionID)
      if (!bound) return
      for (const item of items) {
        const taskID = item.deliveryKey?.startsWith("cortex:taskNotification:")
          ? item.deliveryKey.slice("cortex:taskNotification:".length)
          : undefined
        if (!taskID) continue
        const children = await Session.children(sessionID).catch(() => [])
        const child = children.find((candidate) => candidate.cortex?.taskID === taskID)
        if (!child?.cortex) continue
        await tails.get(child.id)
        const summary = safeSummary(item.summary.preview ?? item.summary.title)
        const safe = { notificationID: item.id, taskID, childSessionID: child.id, status: child.cortex.status, summary }
        await putDraft(
          bound.rootSessionID,
          digest({ type: "notification", sessionID, notificationID: item.id }).slice(0, 32),
          Sync.Event.parse({
            type: "notification",
            sequence: 1,
            sessionID,
            notificationID: item.id,
            kind: "cortex-completion",
            taskID,
            childSessionID: child.id,
            status: child.cortex.status,
            createdAt: item.time.created,
            summary,
            integrity: digest(safe),
          }),
        )
      }
    })
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
          ? await read(AttachmentRecord, Keys.attachment(identity.orgID, sourceSessionID, event.attachmentID))
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
      const parts: Uint8Array[] = []
      let buffered = 0
      let offset = 0
      async function send() {
        if (!buffered) return
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
    if (current?.shareGeneration === share.shareGeneration) return
    const bound = await sessionBinding(rootSessionID)
    if (!bound) return
    const retained: ProjectionRecord[] = []
    for await (const row of Storage.records<unknown>({
      prefix: Keys.projections(identity.orgID, rootSessionID),
      limit: 256,
    })) {
      const projection = ProjectionRecord.safeParse(row.value)
      if (projection.success) retained.push(projection.data)
    }
    retained.sort((a, b) => a.localSequence - b.localSequence)
    await Storage.transaction(async () => {
      const latest = await read(State, Keys.state(identity.orgID, rootSessionID))
      if (latest?.shareGeneration === share.shareGeneration) return
      let nextDraft = latest?.nextDraft ?? 1
      for (const projection of retained) {
        const draftKey = Keys.draft(identity.orgID, rootSessionID, projection.draftID)
        const previous = await read(Draft, draftKey)
        const localSequence = previous?.localSequence ?? projection.localSequence
        nextDraft = Math.max(nextDraft, localSequence + 1)
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
      }
      await Storage.write(
        Keys.state(identity.orgID, rootSessionID),
        State.parse({
          schemaVersion: 1,
          orgID: identity.orgID,
          sessionID: rootSessionID,
          nextDraft,
          shareGeneration: share.shareGeneration,
          syncState: "pending",
          updatedAt: Date.now(),
        }),
      )
    })
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
    const rows = await Storage.query({ prefix: Keys.drafts(identity.orgID, sessionID), limit: 257 })
    const drafts = rows
      .map((row) => Draft.safeParse(row.value))
      .filter((row): row is { success: true; data: Draft } => row.success)
      .map((row) => row.data)
      .sort((a, b) => a.localSequence - b.localSequence)
      .slice(0, 256)
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
    const share = await connection.syncState(sessionID, signal)
    if (share.shareState !== "shared" || share.syncState === "blocked") return
    await prepareGeneration(sessionID, share)
    const batch = await prepare(sessionID, share)
    if (!batch) return
    await uploadBatchBlobs(sessionID, share, batch)
    const ack = await connection.sync(batch, signal)
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
      for (const draftID of stored.draftIDs) await Storage.remove(Keys.draft(identity.orgID, sessionID, draftID))
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
          updatedAt: Date.now(),
        }),
      )
    })
  }

  async function flush() {
    if (running || closed || signal.aborted) return running
    running = (async () => {
      for (const sessionID of [...sessions]) {
        if (closed || signal.aborted) return
        try {
          await flushSession(sessionID)
        } catch {
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
              updatedAt: Date.now(),
            }),
          ).catch(() => {})
        }
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }

  unsubs.push(Bus.subscribeGlobal(SessionEvent.Updated, (event) => observeSession(event.properties.info.id)))
  unsubs.push(Bus.subscribeGlobal(MessageV2.Event.Updated, (event) => observeMessage(event.properties.info)))
  unsubs.push(
    Bus.subscribeGlobal(MessageV2.Event.PartUpdated, (event) => {
      const part = event.properties.part
      if (part.type === "attachment") observeAttachment(part)
      if (part.type === "tool" && part.state.status === "completed")
        for (const attachment of part.state.attachments ?? []) observeAttachment(attachment)
    }),
  )
  unsubs.push(
    Bus.subscribeGlobal(RolloutEvents.Updated, (event) => {
      if (event.properties.owner.kind !== "session") return
      observeTool({ sessionID: event.properties.owner.sessionID, record: event.properties.record })
    }),
  )
  unsubs.push(
    Bus.subscribeGlobal(SessionInbox.Event.Updated, (event) => {
      void observeNotification(event.properties.sessionID, event.properties.items)
    }),
  )
  signal.addEventListener("abort", close, { once: true })
  void Storage.query({ prefix: Keys.sessions(identity.orgID), limit: 4096 })
    .then((rows) => rows.forEach((row) => row.key[3] && sessions.add(row.key[3])))
    .then(schedule)
    .catch(() => {})

  function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    clearInterval(retryTimer)
    for (const unsubscribe of unsubs) unsubscribe()
    signal.removeEventListener("abort", close)
  }

  return {
    flush: async () => {
      await flush()
    },
    close,
  }
}
