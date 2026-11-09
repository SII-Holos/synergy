import { createHash } from "node:crypto"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { z } from "zod"
import type { Credentials } from "./auth/session"
import { authorize } from "./authorization"
import { digest } from "./auth/secret"
import { OrganizationError, fail, revision } from "./error"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"

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

function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function mismatch(message: string): never {
  fail("INVALID_REQUEST", message)
}

const blobChunkBytes = 4 * 1024 * 1024
type BlobUploadInput = {
  sessionID: string
  shareGeneration: number
  hash: string
  offset: number
  totalBytes: number
  bytes: Uint8Array
}

function blobStatus(manifest: Record.SharedBlob): Sync.BlobStatus {
  const offsets = new Set(manifest.chunks.map((chunk) => chunk.offset))
  let nextOffset = 0
  while (offsets.has(nextOffset)) {
    const chunk = manifest.chunks.find((value) => value.offset === nextOffset)
    if (!chunk) break
    nextOffset += chunk.bytes
  }
  return Sync.BlobStatus.parse({
    sessionID: manifest.sessionID,
    shareGeneration: manifest.shareGeneration,
    hash: manifest.hash,
    bytes: manifest.bytes,
    chunkBytes: blobChunkBytes,
    receivedBytes: manifest.receivedBytes,
    complete: manifest.complete,
    nextOffset: manifest.complete ? undefined : nextOffset,
  })
}

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
  if (handshake.runtimeKind !== "member") fail("PERMISSION_DENIED", "Only a member Runtime may export Session sync")
  const [runtime, member, session] = await Promise.all([
    Record.read(Record.RuntimeRegistration, Keys.runtime(handshake.runtimeID)),
    Record.read(Record.Account, Keys.account(handshake.accountID)),
    Record.read(Record.SessionDirectory, Keys.session(sessionID)),
  ])
  if (
    !runtime ||
    !member ||
    runtime.state !== "active" ||
    member.state !== "active" ||
    runtime.orgID !== handshake.orgID ||
    runtime.deploymentIncarnation !== handshake.deploymentIncarnation ||
    runtime.accountID !== handshake.accountID ||
    runtime.connectionEpoch !== handshake.connectionEpoch ||
    member.orgID !== handshake.orgID ||
    !session ||
    session.orgID !== handshake.orgID ||
    session.driverRuntimeID !== handshake.runtimeID
  )
    fail("PERMISSION_DENIED", "Runtime is not the current Session driver")
  return session
}

async function uploadBlobChunk(input: BlobUploadInput, loadSession: () => Promise<Record.SessionDirectory>) {
  const hash = Protocol.Digest.parse(input.hash)
  const shareGeneration = Identity.Revision.parse(input.shareGeneration)
  const offset = z.number().int().nonnegative().parse(input.offset)
  const totalBytes = z.number().int().positive().safe().parse(input.totalBytes)
  if (!input.bytes.byteLength || input.bytes.byteLength > blobChunkBytes)
    fail("INVALID_REQUEST", "Blob chunks must contain between one byte and 4 MiB")
  if (offset % blobChunkBytes !== 0 || offset + input.bytes.byteLength > totalBytes)
    fail("INVALID_REQUEST", "Blob chunk offset is not aligned to its declared size")
  const active = async () => {
    const session = await loadSession()
    if (session.shareState !== "shared" || session.shareGeneration !== shareGeneration)
      fail("SHARE_REVOKED", "The Session share generation is no longer active")
    return session
  }
  await Storage.snapshot(active)
  const chunkKey = Keys.sharedBlobChunk(input.sessionID, shareGeneration, hash, offset)
  await Storage.writeBinary(chunkKey, input.bytes)
  const manifest = await Storage.transaction(async () => {
    const session = await active()
    const key = Keys.sharedBlob(input.sessionID, shareGeneration, hash)
    const current = await Record.read(Record.SharedBlob, key)
    if (current && (current.bytes !== totalBytes || current.hash !== hash))
      fail("REVISION_CONFLICT", "Blob metadata cannot change after its first chunk")
    const chunks = [...(current?.chunks ?? [])].filter((chunk) => chunk.offset !== offset)
    chunks.push({ offset, bytes: input.bytes.byteLength })
    chunks.sort((a, b) => a.offset - b.offset)
    const receivedBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
    const complete =
      receivedBytes === totalBytes &&
      chunks.every(
        (chunk, index) => chunk.offset === (index === 0 ? 0 : chunks[index - 1]!.offset + chunks[index - 1]!.bytes),
      )
    const next = Record.SharedBlob.parse({
      schemaVersion: 1,
      sessionID: session.sessionID,
      shareGeneration,
      hash,
      bytes: totalBytes,
      chunkBytes: blobChunkBytes,
      chunks,
      receivedBytes,
      complete,
      createdAt: current?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    })
    await Storage.write(key, next)
    return next
  })
  if (manifest.complete) {
    const parts = await Promise.all(
      manifest.chunks.map((chunk) =>
        Storage.readBinary(Keys.sharedBlobChunk(input.sessionID, shareGeneration, hash, chunk.offset)),
      ),
    )
    const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)))
    const computed = createHash("sha256").update(bytes).digest("hex")
    if (bytes.byteLength !== manifest.bytes || computed !== manifest.hash) {
      await Storage.removeTree(Keys.sharedBlob(input.sessionID, shareGeneration, hash))
      fail("INVALID_REQUEST", "Blob bytes do not match the declared content hash")
    }
  }
  return blobStatus(manifest)
}

async function commitBatch(session: Record.SessionDirectory, batch: Sync.Batch) {
  if (session.shareState !== "shared" || batch.shareGeneration !== session.shareGeneration)
    fail("SHARE_REVOKED", "The Session share generation is no longer active")
  if (batch.projectID !== session.projectID) mismatch("Sync batch project does not match the Session")
  if (batch.bindingEpoch !== session.bindingEpoch) fail("STALE_BINDING", "Sync batch binding is stale")
  if (payloadHash(batch) !== batch.payloadHash) mismatch("Sync batch payload hash is invalid")
  const events = batch.events.map((event) => {
    if (event.type !== "session") return event
    const expected = expectedSessionEvent(session, batch.shareGeneration)
    if (!equal({ ...event.session, createdAt: expected.createdAt }, expected))
      mismatch("Session projection metadata does not match the authoritative directory")
    return { ...event, session: expected }
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
  for (const event of events)
    await Storage.write(
      Keys.sharedEvent(session.sessionID, session.shareGeneration, event.sequence),
      Record.SharedEvent.parse({ schemaVersion: 1, event }),
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
  export async function get(credentials: Credentials, sessionID: string) {
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      return view(session)
    })
  }

  export async function share(credentials: Credentials, sessionID: string, input: Sync.ShareChange) {
    const change = Sync.ShareChange.parse(input)
    return Storage.transaction(async () => {
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
      return view(updated)
    })
  }

  export async function unshare(credentials: Credentials, sessionID: string, input: Sync.ShareChange) {
    const change = Sync.ShareChange.parse(input)
    return Storage.transaction(async () => {
      const { account, session } = await authorize(credentials, "session.read", { sessionID })
      requireCreator(account.accountID, session)
      revision(change.expectedShareGeneration, session.shareGeneration)
      requireNoHandoff(session)
      if (session.shareState === "private") return view(session)
      const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(session.driverRuntimeID))
      if (!runtime || runtime.orgID !== session.orgID || runtime.accountID !== account.accountID)
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

  export async function applyBatch(credentials: Credentials, input: Sync.Batch) {
    const batch = Sync.Batch.parse(input)
    return Storage.transaction(async () => {
      const { account, session } = await authorize(credentials, "session.read", { sessionID: batch.sessionID })
      requireCreator(account.accountID, session)
      return commitBatch(session, batch)
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
    return uploadBlobChunk(
      { sessionID, ...input },
      async () => (await authorize(credentials, "session.read", { sessionID })).session,
    )
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
    input: { shareGeneration: number; hash: string },
  ) {
    const status = await getBlobStatus(credentials, sessionID, input)
    if (!status.complete) fail("BLOB_INCOMPLETE", "Blob upload is incomplete")
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(status.bytes / blobChunkBytes) }, (_, index) =>
        Storage.readBinary(
          Keys.sharedBlobChunk(sessionID, status.shareGeneration, status.hash, index * blobChunkBytes),
          { maxBytes: blobChunkBytes },
        ),
      ),
    )
    const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)))
    if (bytes.byteLength !== status.bytes || createHash("sha256").update(bytes).digest("hex") !== status.hash)
      fail("SERVICE_UNAVAILABLE", "Blob storage integrity could not be verified")
    return bytes
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
}
