import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
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
      if (session.shareState !== "shared" || batch.shareGeneration !== session.shareGeneration)
        fail("SHARE_REVOKED", "The Session share generation is no longer active")
      if (batch.projectID !== session.projectID) mismatch("Sync batch project does not match the Session")
      if (batch.bindingEpoch !== session.bindingEpoch) fail("STALE_BINDING", "Sync batch binding is stale")
      if (payloadHash(batch) !== batch.payloadHash) mismatch("Sync batch payload hash is invalid")
      for (const event of batch.events) {
        if (event.type === "session" && !equal(event.session, expectedSessionEvent(session, batch.shareGeneration)))
          mismatch("Session projection metadata does not match the authoritative directory")
      }
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
      for (const event of batch.events)
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
}
