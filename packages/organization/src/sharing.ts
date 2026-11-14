import { OrganizationSharedBlobs } from "./shared-blob"
import { OrganizationSharedHistory } from "./shared-history"
import { createHash } from "node:crypto"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
  OrganizationSessionToolProtocol as SessionTool,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { z } from "zod"
import type { Credentials } from "./auth/session"
import { authorize } from "./authorization"
import { digest } from "./auth/secret"
import { OrganizationError, fail, revision } from "./error"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationSharedProjection as Projection } from "./shared-projection"
import { OrganizationSharedTasks as Tasks } from "./shared-tasks"
import { runtimeAuthority, assertRuntimeConnection } from "./runtime-authority"
import { OrganizationAuthorityHistory as History } from "./authority-history"

function payloadHash(batch: Sync.Batch) {
  return digest(JSON.stringify({ firstSeq: batch.firstSeq, lastSeq: batch.lastSeq, events: batch.events }))
}

function expectedSessionEvent(session: Record.SessionDirectory, shareGeneration: number) {
  return {
    sessionID: session.sessionID,
    projectID: session.projectID,
    creatorID: session.creatorID,
    driverRuntimeID: session.driverRuntimeID,
    bindingEpoch: session.bindingEpoch,
    createdAt: session.createdAt,
    shareGeneration,
  }
}

function eventSessionID(event: Sync.Event, rootSessionID: string) {
  if (event.type === "session") return event.session.sessionID
  if (event.type === "cortex" || event.type === "notification") return event.sessionID
  return event.sessionID ?? rootSessionID
}

function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function mismatch(message: string): never {
  fail("INVALID_REQUEST", message)
}

function searchFields(event: Sync.Event) {
  switch (event.type) {
    case "session":
      return { sessionID: event.session.sessionID, id: event.session.sessionID, text: JSON.stringify(event.session) }
    case "message":
      return { sessionID: event.sessionID, id: event.messageID, text: `${event.messageID} ${event.summary}` }
    case "part": {
      const part = event.part
      const contents =
        part?.type === "text" || part?.type === "reasoning" || part?.type === "notice"
          ? [part.content]
          : part?.type === "tool"
            ? [part.input, part.output, part.error]
            : []
      return {
        sessionID: event.sessionID,
        id: event.partID,
        text: contents.map((value) => (value?.kind === "inline" ? value.text : "")).join("\n"),
      }
    }
    case "tool":
      return { sessionID: event.sessionID, id: event.callID, text: `${event.callID} ${event.name} ${event.summary}` }
    case "attachment":
      return {
        sessionID: event.sessionID,
        id: event.attachmentID,
        text: `${event.attachmentID} ${event.filename} ${event.mediaType} ${event.hash}`,
      }
    case "cortex":
      return {
        sessionID: event.sessionID,
        id: event.taskID,
        text: `${event.taskID} ${event.description} ${event.summary}`,
      }
    case "notification":
      return {
        sessionID: event.sessionID,
        id: event.notificationID,
        text: `${event.notificationID} ${event.taskID} ${event.summary}`,
      }
    case "blob":
      return {
        sessionID: event.sessionID,
        id: event.blobID,
        text: `${event.blobID} ${event.kind} ${event.mediaType} ${event.hash}`,
      }
  }
}

function searchSnippet(text: string, query: string) {
  const lower = text.toLocaleLowerCase()
  const index = lower.indexOf(query.toLocaleLowerCase())
  if (index < 0) return text.slice(0, 512)
  const start = Math.max(0, index - 128)
  return text.slice(start, Math.min(text.length, start + 512))
}

const blobChunkBytes = 4 * 1024 * 1024
function blobRange(value: string | undefined, bytes: number) {
  if (!value) return { start: 0, end: bytes - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes - 1) : bytes - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes || end < start) return
  return { start, end }
}
type BlobUploadInput = {
  sessionID: string
  shareGeneration: number
  hash: string
  offset: number
  totalBytes: number
  bytes: Uint8Array
}

const blobStatus = OrganizationSharedBlobs.status

async function currentState(session: Record.SessionDirectory) {
  const stored = await Record.read(Record.SharedState, Keys.sharedState(session.sessionID))
  if (
    stored &&
    stored.sessionID === session.sessionID &&
    stored.shareGeneration === session.shareGeneration &&
    stored.bindingEpoch === session.bindingEpoch
  )
    return stored
  return Record.SharedState.parse({
    schemaVersion: 1,
    sessionID: session.sessionID,
    shareGeneration: session.shareGeneration,
    bindingEpoch: session.bindingEpoch,
    nextSeq: 1,
    syncState: session.shareState === "shared" ? "pending" : "blocked",
    updatedAt: session.createdAt,
  })
}

async function transcriptSnapshot<T>(
  credentials: Credentials | (() => Promise<Record.SessionDirectory>),
  sessionID: string,
  source: string | undefined,
  watermark: number | undefined,
  read: (context: { session: Record.SessionDirectory; sourceSessionID: string; watermark: number }) => Promise<T>,
  prepare?: (input: {
    sessionID: string
    generation: number
    watermark: number
    authorize(): Promise<unknown>
  }) => Promise<void>,
) {
  const access =
    typeof credentials === "function"
      ? credentials
      : async () => (await authorize(credentials, "session.read", { sessionID })).session
  const initial = await Storage.snapshot(access)
  const generation = initial.shareGeneration
  const check = async () => {
    const current = await access()
    if (current.sessionID !== sessionID || current.shareState !== "shared" || current.shareGeneration !== generation)
      fail("SHARE_REVOKED", "The Session share generation is no longer active")
    return current
  }
  await check()
  const fixed = prepare
    ? await Storage.snapshot(async () => {
        const session = await check()
        const state = await currentState(session)
        const selected = watermark ?? state.nextSeq - 1
        if (selected >= state.nextSeq) fail("REVISION_CONFLICT", "Snapshot watermark is ahead of its checkpoint")
        return selected
      })
    : undefined
  if (prepare && fixed !== undefined) await prepare({ sessionID, generation, watermark: fixed, authorize: check })
  else await Projection.prepare(sessionID, generation, check)
  return Storage.snapshot(async () => {
    const session = await check()
    const state = await currentState(session)
    const selected = fixed ?? watermark ?? state.nextSeq - 1
    if (selected >= state.nextSeq) fail("REVISION_CONFLICT", "Snapshot watermark is ahead of its checkpoint")
    const sourceSessionID = source ?? sessionID
    if (sourceSessionID !== sessionID) {
      const child = await Record.read(Record.SharedSession, Keys.sharedSession(sessionID, generation, sourceSessionID))
      if (!child || child.rootSessionID !== sessionID) fail("NOT_FOUND", "Shared child Session not found")
    }
    return read({ session, sourceSessionID, watermark: selected })
  })
}

function decodeWindowCursor<T>(cursor: string | undefined, schema: z.ZodType<T>) {
  if (!cursor) return
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
  } catch {
    fail("INVALID_REQUEST", "Invalid transcript window cursor")
  }
}

const WindowPosition = z.strictObject({
  sessionID: Identity.ID,
  sourceSessionID: Identity.ID,
  shareGeneration: Identity.Revision,
  watermark: Identity.Revision,
  kind: z.enum(["messages", "parts", "tasks"]),
  messageID: Identity.ID.optional(),
  position: z.array(Identity.ID).min(1).max(2),
})
type WindowBinding = Omit<z.infer<typeof WindowPosition>, "position">

function checkWindowCursor(cursor: z.infer<typeof WindowPosition> | undefined, binding: WindowBinding, latest = false) {
  if (
    cursor &&
    !equal(
      { ...cursor, ...(latest ? { watermark: binding.watermark } : {}), position: undefined },
      { ...binding, position: undefined },
    )
  )
    fail("REVISION_CONFLICT", "Transcript cursor belongs to another window or sharing generation")
}

function encodeWindowCursor(key: string[], prefix: string[], binding: WindowBinding) {
  return Buffer.from(JSON.stringify({ ...binding, position: key.slice(prefix.length) })).toString("base64url")
}

async function indexedEvents(
  sessionID: string,
  generation: number,
  rows: Array<{ key: string[]; value: unknown }>,
  watermark: number,
) {
  const values = await Promise.all(
    rows.map((row) =>
      Projection.at(
        sessionID,
        generation,
        z.strictObject({ objectID: Protocol.Digest }).parse(row.value).objectID,
        watermark,
      ),
    ),
  )
  return values.flatMap((value, index) =>
    value &&
    !((value.event.type === "message" || value.event.type === "part") && value.event.removed) &&
    Projection.matchesIndex(sessionID, generation, value.event, rows[index]!.key)
      ? [value.event]
      : [],
  )
}

async function view(session: Record.SessionDirectory): Promise<Sync.Share> {
  const state = await currentState(session)
  return Sync.Share.parse({
    sessionID: session.sessionID,
    shareState: session.shareState,
    shareGeneration: session.shareGeneration,
    bindingEpoch: session.bindingEpoch,
    nextSeq: state.nextSeq,
    syncState: state.syncState,
    updatedAt: state.updatedAt,
  })
}

function requireCreator(accountID: string, session: Record.SessionDirectory) {
  if (accountID !== session.creatorID) fail("NOT_FOUND", "Session not found")
}

function requireNoHandoff(session: Record.SessionDirectory) {
  if (session.handoffID) fail("HANDOFF_BLOCKED", "Session handoff must finish before sharing changes")
}

function writeVisibility(session: Record.SessionDirectory, state: "private" | "shared") {
  return state === "shared"
    ? Promise.all([
        Storage.remove(Keys.visibleSession("private", session.projectID, session.sessionID)),
        Storage.write(
          Keys.visibleSession("shared", session.projectID, session.sessionID),
          Record.SessionIndex.parse({ sessionID: session.sessionID }),
        ),
      ])
    : Promise.all([
        Storage.remove(Keys.visibleSession("shared", session.projectID, session.sessionID)),
        Storage.write(
          Keys.visibleSession("private", session.projectID, session.sessionID),
          Record.SessionIndex.parse({ sessionID: session.sessionID }),
        ),
      ])
}

function stateRecord(
  session: Record.SessionDirectory,
  syncState: z.infer<typeof Sync.SyncState>,
  nextSeq = 1,
): Record.SharedState {
  return Record.SharedState.parse({
    schemaVersion: 1,
    sessionID: session.sessionID,
    shareGeneration: session.shareGeneration,
    bindingEpoch: session.bindingEpoch,
    nextSeq,
    syncState,
    updatedAt: Date.now(),
  })
}

async function runtimeSession(handshake: Protocol.Handshake, sessionID: string) {
  const [{ runtime }, session] = await Promise.all([
    runtimeAuthority(handshake),
    Record.read(Record.SessionDirectory, Keys.session(sessionID)),
  ])
  assertRuntimeConnection(runtime, handshake)
  if (!session || session.orgID !== handshake.orgID || session.driverRuntimeID !== handshake.runtimeID)
    fail("PERMISSION_DENIED", "Runtime is not the current Session driver")
  return session
}

async function validateProjectionEvents(session: Record.SessionDirectory, batch: Sync.Batch) {
  const projections = new Map<string, Sync.SessionProjection>()
  for (const event of batch.events)
    if (event.type === "session") projections.set(event.session.sessionID, event.session)

  const loaded = new Map<string, Sync.SessionProjection>()
  async function readProjection(sessionID: string) {
    const inBatch = projections.get(sessionID)
    if (inBatch) return inBatch
    const stored = await Record.read(
      Record.SharedSession,
      Keys.sharedSession(session.sessionID, session.shareGeneration, sessionID),
    )
    return stored?.projection
  }

  const root = await readProjection(session.sessionID)
  if (!root) mismatch("Sync batch must establish the shared root projection before child events")
  const expected = expectedSessionEvent(session, batch.shareGeneration)
  const { title: _title, status: _status, ...binding } = root
  if (!equal({ ...binding, createdAt: expected.createdAt }, expected))
    mismatch("Root Session projection metadata does not match the authoritative directory")
  loaded.set(session.sessionID, root)

  async function load(sessionID: string, visiting = new Set<string>()): Promise<Sync.SessionProjection | undefined> {
    const cached = loaded.get(sessionID)
    if (cached) return cached
    if (visiting.has(sessionID)) mismatch("Shared Cortex Session projection contains a cycle")
    visiting.add(sessionID)
    const projection = await readProjection(sessionID)
    if (!projection) return undefined
    if (projection.sessionID !== sessionID) mismatch("Shared Session projection identity is inconsistent")
    if (sessionID !== session.sessionID) {
      if (
        projection.rootSessionID !== session.sessionID ||
        !projection.parentSessionID ||
        !projection.cortex ||
        projection.cortex.parentSessionID !== projection.parentSessionID
      )
        mismatch("Only Cortex descendants of the shared root may enter its projection")
      const parent = await load(projection.parentSessionID, visiting)
      if (!parent || parent.projectID !== session.projectID || parent.rootSessionID === sessionID)
        mismatch("Shared Cortex child does not resolve to the current shared root")
    }
    if (
      projection.projectID !== session.projectID ||
      projection.creatorID !== session.creatorID ||
      projection.driverRuntimeID !== session.driverRuntimeID ||
      projection.bindingEpoch !== session.bindingEpoch ||
      projection.shareGeneration !== batch.shareGeneration
    )
      mismatch("Shared Session projection binding is inconsistent")
    loaded.set(sessionID, projection)
    visiting.delete(sessionID)
    return projection
  }

  for (const event of batch.events) {
    const sourceSessionID = eventSessionID(event, session.sessionID)
    const source = await load(sourceSessionID)
    if (!source) mismatch("Sync event references an unshared or unknown Session")
    if (event.type === "cortex") {
      if (
        sourceSessionID !== event.sessionID ||
        !source.cortex ||
        source.cortex.taskID !== event.taskID ||
        source.cortex.parentSessionID !== event.parentSessionID ||
        source.cortex.parentMessageID !== event.parentMessageID ||
        source.cortex.status !== event.status
      )
        mismatch("Cortex event does not match its Session projection")
    }
    if (event.type === "notification") {
      const child = await load(event.childSessionID)
      if (
        !child?.cortex ||
        child.cortex.taskID !== event.taskID ||
        child.cortex.parentSessionID !== event.sessionID ||
        child.cortex.status !== event.status
      )
        mismatch("Cortex notification does not match its child projection")
    }
  }

  return loaded
}

async function uploadBlobChunk(input: BlobUploadInput, loadSession: () => Promise<Record.SessionDirectory>) {
  return OrganizationSharedBlobs.upload(input, loadSession)
}

async function commitBatch(session: Record.SessionDirectory, batch: Sync.Batch) {
  if (session.shareState !== "shared" || batch.shareGeneration !== session.shareGeneration)
    fail("SHARE_REVOKED", "The Session share generation is no longer active")
  if (batch.projectID !== session.projectID) mismatch("Sync batch project does not match the Session")
  if (batch.bindingEpoch !== session.bindingEpoch) fail("STALE_BINDING", "Sync batch binding is stale")
  if (payloadHash(batch) !== batch.payloadHash) mismatch("Sync batch payload hash is invalid")
  const projections = await validateProjectionEvents(session, batch)
  const events = batch.events.map((event) => {
    if (event.type !== "session" || event.session.sessionID !== session.sessionID) return event
    return {
      ...event,
      session: {
        ...expectedSessionEvent(session, batch.shareGeneration),
        ...(event.session.title === undefined ? {} : { title: event.session.title }),
        ...(event.session.status === undefined ? {} : { status: event.session.status }),
      },
    }
  })
  const state = await Record.read(Record.SharedState, Keys.sharedState(session.sessionID))
  if (
    !state ||
    state.sessionID !== session.sessionID ||
    state.shareGeneration !== session.shareGeneration ||
    state.bindingEpoch !== session.bindingEpoch
  )
    fail("SERVICE_UNAVAILABLE", "Shared sync state is unavailable")
  if (batch.firstSeq < state.nextSeq) {
    const previous = await Record.read(
      Record.SharedBatch,
      Keys.sharedBatch(session.sessionID, session.shareGeneration, batch.firstSeq),
    )
    if (
      previous &&
      previous.sessionID === batch.sessionID &&
      previous.projectID === batch.projectID &&
      previous.bindingEpoch === batch.bindingEpoch &&
      previous.shareGeneration === batch.shareGeneration &&
      previous.firstSeq === batch.firstSeq &&
      previous.lastSeq === batch.lastSeq &&
      previous.payloadHash === batch.payloadHash
    )
      return Sync.Ack.parse({
        sessionID: session.sessionID,
        bindingEpoch: session.bindingEpoch,
        shareGeneration: session.shareGeneration,
        nextSeq: state.nextSeq,
        syncState: state.syncState,
      })
    fail("REVISION_CONFLICT", "Sync batch overlaps a committed sequence", state.nextSeq)
  }
  if (batch.firstSeq > state.nextSeq)
    throw new OrganizationError({
      code: "REVISION_CONFLICT",
      message: "Sync batch has a sequence gap",
      currentRevision: state.nextSeq,
      missingRequirements: [`sequence:${state.nextSeq}`],
      outcome: "not_dispatched",
      retryable: false,
    })
  for (const event of events) {
    await Storage.write(
      Keys.sharedEvent(session.sessionID, session.shareGeneration, event.sequence),
      Record.SharedEvent.parse({ schemaVersion: 1, event }),
    )
    await Projection.write(session.sessionID, session.shareGeneration, event)
  }
  for (const projection of projections.values())
    await Storage.write(
      Keys.sharedSession(session.sessionID, session.shareGeneration, projection.sessionID),
      Record.SharedSession.parse({ schemaVersion: 1, rootSessionID: session.sessionID, projection }),
    )
  await Storage.write(
    Keys.sharedBatch(session.sessionID, session.shareGeneration, batch.firstSeq),
    Record.SharedBatch.parse({
      schemaVersion: 1,
      sessionID: batch.sessionID,
      projectID: batch.projectID,
      bindingEpoch: batch.bindingEpoch,
      shareGeneration: batch.shareGeneration,
      firstSeq: batch.firstSeq,
      lastSeq: batch.lastSeq,
      payloadHash: batch.payloadHash,
      committedAt: Date.now(),
    }),
  )
  const next = stateRecord(session, "synced", batch.lastSeq + 1)
  await Storage.write(Keys.sharedState(session.sessionID), next)
  return Sync.Ack.parse({
    sessionID: session.sessionID,
    bindingEpoch: session.bindingEpoch,
    shareGeneration: session.shareGeneration,
    nextSeq: next.nextSeq,
    syncState: next.syncState,
  })
}

export namespace OrganizationSharing {
  export const history = OrganizationSharedHistory.history
  export const historicalArtifact = OrganizationSharedBlobs.historicalArtifact
  export const describe = view
  export async function readForExecution(input: {
    query: SessionTool.ReadQuery
    authorize(): Promise<Record.SessionDirectory>
    signal: AbortSignal
  }) {
    const query = SessionTool.ReadQuery.parse(input.query)
    const sessionID = query.targetSessionID
    return transcriptSnapshot(input.authorize, sessionID, undefined, undefined, async ({ session, watermark }) => {
      const prefix = Projection.messages(sessionID, session.shareGeneration, sessionID)
      const anchor = query.around
        ? await Projection.message(sessionID, session.shareGeneration, sessionID, query.around, watermark)
        : undefined
      if (query.around && (!anchor || anchor.event.type !== "message" || anchor.event.removed))
        fail("NOT_FOUND", "Shared message not found")
      const anchorEvent = anchor?.event.type === "message" ? anchor.event : undefined
      const collect = async (count: number, descending: boolean, initial?: string[], offset = 0) => {
        let after = initial
        let skipped = 0
        const messages: Array<z.infer<typeof Sync.MessageEvent>> = []
        while (messages.length <= count) {
          input.signal.throwIfAborted()
          await input.authorize()
          const rows = await Storage.query({ prefix, after, descending, limit: 64 })
          if (!rows.length) break
          for (const event of await indexedEvents(sessionID, session.shareGeneration, rows, watermark)) {
            if (skipped++ < offset) continue
            messages.push(Sync.MessageEvent.parse(event))
            if (messages.length > count) break
          }
          after = rows.at(-1)!.key
          if (rows.length < 64) break
        }
        return { messages: messages.slice(0, count), more: messages.length > count }
      }
      let selected: Awaited<ReturnType<typeof collect>>
      if (anchorEvent && query.limit) {
        const anchorKey = [...prefix, String(anchorEvent.createdAt).padStart(20, "0"), anchorEvent.messageID]
        const newer = await collect(Math.floor(query.limit / 2), false, anchorKey)
        const older = await collect(query.limit - newer.messages.length - 1, true, anchorKey)
        if (newer.more && newer.messages.length + older.messages.length + 1 < query.limit) {
          const fill = await collect(query.limit - older.messages.length - 1, false, anchorKey)
          newer.messages = fill.messages
          newer.more = fill.more
        }
        selected = {
          messages: [...newer.messages.reverse(), anchorEvent, ...older.messages],
          more: newer.more || older.more,
        }
      } else selected = await collect(query.limit, true, undefined, query.offset)
      let partial = selected.more || query.offset > 0
      let bytes = 0
      const items: SessionTool.ReadResult["items"] = []
      for (const message of selected.messages) {
        input.signal.throwIfAborted()
        bytes += Buffer.byteLength(JSON.stringify(message))
        if (bytes > 1024 * 1024) {
          partial = true
          break
        }
        const partsPrefix = Projection.parts(sessionID, session.shareGeneration, sessionID, message.messageID)
        const partRows = await Storage.query({ prefix: partsPrefix, limit: 129 })
        const projected = (
          await indexedEvents(sessionID, session.shareGeneration, partRows.slice(0, 128), watermark)
        ).map((event) => Sync.PartEvent.parse(event))
        const parts: SessionTool.ReadResult["items"][number]["parts"] = []
        for (const part of projected) {
          bytes += Buffer.byteLength(JSON.stringify(part))
          if (bytes > 1024 * 1024) {
            partial = true
            break
          }
          parts.push(part)
        }
        if (partRows.length > 128) partial = true
        items.push({ message, parts })
        if (bytes > 1024 * 1024) break
      }
      input.signal.throwIfAborted()
      const shared = await Record.read(
        Record.SharedSession,
        Keys.sharedSession(sessionID, session.shareGeneration, sessionID),
      )
      return {
        targetSessionID: sessionID,
        shareGeneration: session.shareGeneration,
        watermark,
        title: shared?.projection.title ?? "Shared Session",
        items,
        partial,
      }
    })
  }
  export async function tasks(credentials: Credentials, sessionID: string, value: Sync.TaskQuery) {
    const query = Sync.TaskQuery.parse(value)
    const cursor = decodeWindowCursor(query.cursor, WindowPosition)
    const after = cursor && z.tuple([Identity.ID]).parse(cursor.position)[0]
    return transcriptSnapshot(
      credentials,
      sessionID,
      query.sourceSessionID ?? cursor?.sourceSessionID,
      query.watermark ?? cursor?.watermark,
      async ({ session, sourceSessionID, watermark }) => {
        const binding: WindowBinding = {
          sessionID,
          sourceSessionID,
          shareGeneration: session.shareGeneration,
          watermark,
          kind: "tasks",
        }
        checkWindowCursor(cursor, binding)
        const page = await Tasks.page({
          sessionID,
          generation: session.shareGeneration,
          parentSessionID: sourceSessionID,
          watermark,
          after,
          limit: query.limit,
        })
        return Sync.TaskPage.parse({
          sessionID,
          sourceSessionID,
          shareGeneration: session.shareGeneration,
          watermark,
          items: page.items,
          cursor: page.cursor ? encodeWindowCursor([page.cursor], [], binding) : undefined,
        })
      },
      Tasks.prepare,
    )
  }
  export async function messages(credentials: Credentials, sessionID: string, value: Sync.MessageQuery) {
    const query = Sync.MessageQuery.parse(value)
    const cursor = decodeWindowCursor(query.cursor, WindowPosition)
    const after = cursor && z.tuple([z.string().regex(/^\d{20}$/), Identity.ID]).parse(cursor.position)
    return transcriptSnapshot(
      credentials,
      sessionID,
      query.sourceSessionID,
      query.latest ? undefined : (query.watermark ?? cursor?.watermark),
      async ({ session, sourceSessionID, watermark }) => {
        const binding: WindowBinding = {
          sessionID,
          sourceSessionID,
          shareGeneration: session.shareGeneration,
          watermark,
          kind: "messages",
        }
        checkWindowCursor(cursor, binding, query.latest)
        const prefix = Projection.messages(sessionID, session.shareGeneration, sourceSessionID)
        const rows = await Storage.query({
          prefix,
          after: after ? [...prefix, ...after] : undefined,
          descending: true,
          limit: query.limit + 1,
        })
        const selected = rows.slice(0, query.limit)
        const items = (await indexedEvents(sessionID, session.shareGeneration, selected, watermark))
          .map((event) => Sync.MessageEvent.parse(event))
          .filter((event) => event.sequence <= watermark)
          .reverse()
        return Sync.MessagePage.parse({
          sessionID,
          sourceSessionID,
          shareGeneration: session.shareGeneration,
          watermark,
          items,
          cursor: rows.length > query.limit ? encodeWindowCursor(selected.at(-1)!.key, prefix, binding) : undefined,
        })
      },
    )
  }

  export async function parts(credentials: Credentials, sessionID: string, value: Sync.PartQuery) {
    const query = Sync.PartQuery.parse(value)
    const cursor = decodeWindowCursor(query.cursor, WindowPosition)
    const after = cursor && z.tuple([Identity.ID]).parse(cursor.position)
    return transcriptSnapshot(
      credentials,
      sessionID,
      query.sourceSessionID,
      query.latest ? undefined : (query.watermark ?? cursor?.watermark),
      async ({ session, sourceSessionID, watermark }) => {
        const binding: WindowBinding = {
          sessionID,
          sourceSessionID,
          shareGeneration: session.shareGeneration,
          watermark,
          kind: "parts",
          messageID: query.messageID,
        }
        checkWindowCursor(cursor, binding, query.latest)
        const message = await Projection.message(
          sessionID,
          session.shareGeneration,
          sourceSessionID,
          query.messageID,
          watermark,
        )
        if (!message || message.event.type !== "message" || message.event.removed)
          fail("NOT_FOUND", "Shared message not found")
        const prefix = Projection.parts(sessionID, session.shareGeneration, sourceSessionID, query.messageID)
        const rows = await Storage.query({
          prefix,
          after: after ? [...prefix, ...after] : undefined,
          limit: query.limit + 1,
        })
        const selected = rows.slice(0, query.limit)
        const items = (await indexedEvents(sessionID, session.shareGeneration, selected, watermark))
          .map((event) => Sync.PartEvent.parse(event))
          .filter((event) => event.sequence <= watermark)
        return Sync.PartPage.parse({
          sessionID,
          sourceSessionID,
          messageID: query.messageID,
          shareGeneration: session.shareGeneration,
          watermark,
          items,
          cursor: rows.length > query.limit ? encodeWindowCursor(selected.at(-1)!.key, prefix, binding) : undefined,
          complete: rows.length <= query.limit,
        })
      },
    )
  }

  export async function rebind(previous: Record.SessionDirectory, next: Record.SessionDirectory) {
    if (!Storage.inTransaction()) fail("INVALID_REQUEST", "Sharing rebind must join the handoff commit")
    if (
      previous.sessionID !== next.sessionID ||
      previous.orgID !== next.orgID ||
      previous.projectID !== next.projectID ||
      previous.creatorID !== next.creatorID ||
      previous.shareState !== next.shareState ||
      previous.shareGeneration !== next.shareGeneration ||
      next.bindingEpoch <= previous.bindingEpoch
    )
      fail("STALE_BINDING", "Sharing rebind cannot change Session identity or visibility")
    const current = await Record.read(Record.SessionDirectory, Keys.session(next.sessionID))
    if (!current || current.bindingEpoch !== next.bindingEpoch || current.driverRuntimeID !== next.driverRuntimeID)
      fail("STALE_BINDING", "Sharing rebind requires the committed destination binding")
    const state = await currentState(previous)
    await Storage.write(
      Keys.sharedState(next.sessionID),
      stateRecord(next, next.shareState === "shared" ? "pending" : "blocked", state.nextSeq),
    )
    if (next.shareState !== "shared") return
    const event = Sync.Event.parse({
      type: "session",
      sequence: state.nextSeq,
      session: expectedSessionEvent(next, next.shareGeneration),
    })
    await commitBatch(
      next,
      Sync.Batch.parse({
        schemaVersion: 1,
        sessionID: next.sessionID,
        projectID: next.projectID,
        bindingEpoch: next.bindingEpoch,
        shareGeneration: next.shareGeneration,
        firstSeq: event.sequence,
        lastSeq: event.sequence,
        events: [event],
        payloadHash: digest(JSON.stringify({ firstSeq: event.sequence, lastSeq: event.sequence, events: [event] })),
      }),
    )
    await Storage.write(Keys.sharedState(next.sessionID), stateRecord(next, "pending", state.nextSeq + 1))
  }

  export async function get(credentials: Credentials, sessionID: string) {
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      return view(session)
    })
  }

  export async function share(credentials: Credentials, sessionID: string, input: Sync.ShareChange) {
    const change = Sync.ShareChange.parse(input)
    return History.credentials(credentials, "session.share", async () => {
      const { account, session } = await authorize(credentials, "session.read", { sessionID })
      requireCreator(account.accountID, session)
      revision(change.expectedShareGeneration, session.shareGeneration)
      requireNoHandoff(session)
      if (session.shareState === "shared") return view(session)
      const updated = Record.SessionDirectory.parse({
        ...session,
        shareState: "shared",
        shareGeneration: session.shareGeneration + 1,
        rowRevision: session.rowRevision + 1,
      })
      await Storage.write(Keys.session(sessionID), updated)
      await writeVisibility(updated, "shared")
      await Storage.write(Keys.sharedState(sessionID), stateRecord(updated, "pending"))
      await Projection.initialize(updated)
      return view(updated)
    })
  }

  export async function unshare(credentials: Credentials, sessionID: string, input: Sync.ShareChange) {
    const change = Sync.ShareChange.parse(input)
    return History.credentials(credentials, "session.unshare", async () => {
      const { account, session } = await authorize(credentials, "session.read", { sessionID })
      requireCreator(account.accountID, session)
      revision(change.expectedShareGeneration, session.shareGeneration)
      requireNoHandoff(session)
      if (session.shareState === "private") return view(session)
      const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(session.driverRuntimeID))
      if (
        !runtime ||
        runtime.orgID !== session.orgID ||
        (runtime.runtimeKind === "member" && runtime.accountID !== account.accountID)
      )
        fail("HANDOFF_BLOCKED", "The current Session driver must be the creator before sharing is revoked")
      const updated = Record.SessionDirectory.parse({
        ...session,
        shareState: "private",
        shareGeneration: session.shareGeneration + 1,
        rowRevision: session.rowRevision + 1,
      })
      await Storage.write(Keys.session(sessionID), updated)
      await writeVisibility(updated, "private")
      await Storage.write(Keys.sharedState(sessionID), stateRecord(updated, "blocked"))
      return view(updated)
    })
  }

  export async function getFromRuntime(handshake: Protocol.Handshake, sessionID: string) {
    return Storage.snapshot(async () => view(await runtimeSession(handshake, sessionID)))
  }

  export async function applyBatchFromRuntime(handshake: Protocol.Handshake, input: Sync.Batch) {
    const batch = Sync.Batch.parse(input)
    return Storage.transaction(async () => commitBatch(await runtimeSession(handshake, batch.sessionID), batch))
  }

  export async function uploadBlob(
    credentials: Credentials,
    sessionID: string,
    input: {
      shareGeneration: number
      hash: string
      offset: number
      totalBytes: number
      bytes: Uint8Array
    },
  ) {
    return uploadBlobChunk({ sessionID, ...input }, async () => {
      const { account, session } = await authorize(credentials, "session.read", { sessionID })
      requireCreator(account.accountID, session)
      return session
    })
  }

  export async function uploadBlobFromRuntime(handshake: Protocol.Handshake, input: BlobUploadInput) {
    return uploadBlobChunk(input, () => runtimeSession(handshake, input.sessionID))
  }

  export async function getBlobStatus(
    credentials: Credentials,
    sessionID: string,
    input: { shareGeneration: number; hash: string },
  ) {
    const hash = Protocol.Digest.parse(input.hash)
    const shareGeneration = Identity.Revision.parse(input.shareGeneration)
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      if (session.shareState !== "shared" || session.shareGeneration !== shareGeneration)
        fail("SHARE_REVOKED", "The Session share generation is no longer active")
      const manifest = await Record.read(Record.SharedBlob, Keys.sharedBlob(sessionID, shareGeneration, hash))
      if (!manifest) fail("NOT_FOUND", "Blob not found")
      return blobStatus(manifest)
    })
  }

  export async function downloadBlob(
    credentials: Credentials,
    sessionID: string,
    input: { shareGeneration: number; hash: string; range?: string; signal?: AbortSignal },
  ) {
    let status = await getBlobStatus(credentials, sessionID, input)
    if (!status.complete && status.receivedBytes === status.bytes) {
      const manifest = await Record.read(
        Record.SharedBlob,
        Keys.sharedBlob(sessionID, status.shareGeneration, status.hash),
      )
      if (!manifest) fail("NOT_FOUND", "Blob not found")
      status = OrganizationSharedBlobs.status(
        await OrganizationSharedBlobs.complete(
          manifest,
          async () => (await authorize(credentials, "session.read", { sessionID })).session,
        ),
      )
    }
    if (!status.complete) fail("BLOB_INCOMPLETE", "Blob upload is incomplete")
    const range = blobRange(input.range, status.bytes)
    if (!range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${status.bytes}` } })
    const hasher = createHash("sha256")
    let byteLength = 0
    for (let offset = 0; offset < status.bytes; offset += blobChunkBytes) {
      input.signal?.throwIfAborted()
      await getBlobStatus(credentials, sessionID, input)
      const bytes = await Storage.readBinary(
        Keys.sharedBlobChunk(sessionID, status.shareGeneration, status.hash, offset),
        { maxBytes: blobChunkBytes },
      )
      byteLength += bytes.byteLength
      hasher.update(bytes)
    }
    if (byteLength !== status.bytes || hasher.digest("hex") !== status.hash)
      fail("SERVICE_UNAVAILABLE", "Blob storage integrity could not be verified")
    let offset = range.start
    const bind = RuntimeContext.current().bind
    const body = new ReadableStream<Uint8Array>(
      {
        pull: bind(async (controller) => {
          input.signal?.throwIfAborted()
          await getBlobStatus(credentials, sessionID, input)
          if (offset > range.end) {
            controller.close()
            return
          }
          const chunkOffset = Math.floor(offset / blobChunkBytes) * blobChunkBytes
          const bytes = await Storage.readBinary(
            Keys.sharedBlobChunk(sessionID, status.shareGeneration, status.hash, chunkOffset),
            { maxBytes: blobChunkBytes },
          )
          const start = offset - chunkOffset
          const length = Math.min(bytes.byteLength - start, range.end - offset + 1)
          if (length <= 0) fail("SERVICE_UNAVAILABLE", "Blob chunk is incomplete")
          input.signal?.throwIfAborted()
          await getBlobStatus(credentials, sessionID, input)
          controller.enqueue(bytes.subarray(start, start + length))
          offset += length
        }),
      },
      { highWaterMark: 0 },
    )
    return new Response(body, {
      status: input.range ? 206 : 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(range.end - range.start + 1),
        etag: `"${status.hash}"`,
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        ...(input.range ? { "content-range": `bytes ${range.start}-${range.end}/${status.bytes}` } : {}),
      },
    })
  }

  export async function snapshot(credentials: Credentials, sessionID: string, input: Sync.SnapshotQuery) {
    const query = Sync.SnapshotQuery.parse(input)
    const initial = await Storage.snapshot(() => authorize(credentials, "session.read", { sessionID }))
    const generation = initial.session.shareGeneration
    const check = async () => {
      const current = await authorize(credentials, "session.read", { sessionID })
      if (current.session.shareState !== "shared" || current.session.shareGeneration !== generation)
        fail("SHARE_REVOKED", "The Session share generation is no longer active")
      return current
    }
    await check()
    await Projection.prepare(sessionID, generation, check)
    return Storage.snapshot(async () => {
      const { session } = await check()
      const state = await currentState(session)
      const watermark = query.watermark ?? state.nextSeq - 1
      if (watermark >= state.nextSeq) fail("REVISION_CONFLICT", "Snapshot watermark is ahead of its checkpoint")
      const prefix = Projection.root(sessionID, generation)
      const rows = await Storage.query({
        prefix,
        after: query.cursor ? [...prefix, query.cursor] : undefined,
        limit: query.limit + 1,
      })
      const selected = rows.slice(0, query.limit)
      const items = selected
        .map((row) => Record.parse(Record.SharedEvent, row.key, row.value).event)
        .filter((event) => event.sequence <= watermark)
      return Sync.SnapshotPage.parse({
        sessionID,
        shareGeneration: generation,
        watermark,
        items,
        cursor: rows.length > query.limit ? selected.at(-1)?.key.at(-1) : undefined,
      })
    })
  }

  export async function events(credentials: Credentials, sessionID: string, input: Sync.EventPageQuery) {
    const page = Sync.EventPageQuery.parse(input)
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      if (session.shareState !== "shared") fail("SHARE_REVOKED", "The Session is private")
      const state = await currentState(session)
      if (page.cursor !== undefined && page.cursor >= state.nextSeq)
        fail("REVISION_CONFLICT", "Sync event cursor is ahead of the committed checkpoint", state.nextSeq)
      const prefix = Keys.sharedEvents(session.sessionID, session.shareGeneration)
      const rows = await Storage.query({
        prefix,
        after: page.cursor === undefined ? undefined : [...prefix, String(page.cursor).padStart(16, "0")],
        limit: page.limit + 1,
      })
      const selected = rows.slice(0, page.limit)
      const items = selected.map((row) => {
        const sequence = Number(row.key.at(-1))
        if (!Number.isSafeInteger(sequence)) fail("SERVICE_UNAVAILABLE", "Shared event index is inconsistent")
        const stored = Record.parse(Record.SharedEvent, row.key, row.value)
        if (stored.event.sequence !== sequence) fail("SERVICE_UNAVAILABLE", "Shared event index is inconsistent")
        return stored.event
      })
      return Sync.EventPage.parse({
        sessionID: session.sessionID,
        shareGeneration: session.shareGeneration,
        nextSeq: state.nextSeq,
        items,
        cursor: rows.length > page.limit ? items.at(-1)?.sequence : undefined,
      })
    })
  }

  export async function search(credentials: Credentials, sessionID: string, input: Sync.SearchQuery) {
    const query = Sync.SearchQuery.parse(input)
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      if (session.shareState !== "shared") fail("SHARE_REVOKED", "The Session is private")
      const state = await currentState(session)
      if (query.cursor !== undefined && query.cursor >= state.nextSeq)
        fail("REVISION_CONFLICT", "Sync search cursor is ahead of the committed checkpoint", state.nextSeq)
      const prefix = Keys.sharedEvents(session.sessionID, session.shareGeneration)
      let after = query.cursor === undefined ? undefined : [...prefix, String(query.cursor).padStart(16, "0")]
      const items: Sync.SearchHit[] = []
      let cursor: number | undefined
      for (;;) {
        const rows = await Storage.query({ prefix, after, limit: 256 })
        if (!rows.length) break
        for (const row of rows) {
          const sequence = Number(row.key.at(-1))
          if (!Number.isSafeInteger(sequence)) fail("SERVICE_UNAVAILABLE", "Shared event index is inconsistent")
          const stored = Record.parse(Record.SharedEvent, row.key, row.value)
          if (stored.event.sequence !== sequence) fail("SERVICE_UNAVAILABLE", "Shared event index is inconsistent")
          const fields = searchFields(stored.event)
          if (!fields.text.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) continue
          items.push(
            Sync.SearchHit.parse({
              sequence,
              sessionID: fields.sessionID ?? session.sessionID,
              kind: stored.event.type,
              id: fields.id,
              snippet: searchSnippet(fields.text, query.q),
              integrity: digest(JSON.stringify(stored.event)),
            }),
          )
          if (items.length === query.limit) {
            cursor = sequence
            break
          }
        }
        if (cursor !== undefined || rows.length < 256) break
        after = rows.at(-1)!.key
      }
      return Sync.SearchPage.parse({
        sessionID: session.sessionID,
        shareGeneration: session.shareGeneration,
        nextSeq: state.nextSeq,
        items,
        cursor,
      })
    })
  }
}
