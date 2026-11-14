import { z } from "zod"
import { createHash } from "node:crypto"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { SessionTransferCore as Core } from "@ericsanchezok/synergy-harness/session/transfer"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSyncPath as Keys } from "./storage/path"

function read<T>(schema: z.ZodType<T>, key: string[]) {
  return Storage.readMany<unknown>([key]).then(([value]) => (value === undefined ? undefined : schema.parse(value)))
}

export const State = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  sessionID: Identity.ID,
  nextDraft: Identity.Revision,
  shareGeneration: Identity.Revision.optional(),
  projectionVersion: z.literal(2).optional(),
  syncState: Sync.SyncState,
  updatedAt: z.number().int().nonnegative(),
})
export type State = z.infer<typeof State>

export const Draft = z.strictObject({
  schemaVersion: z.literal(1),
  draftID: Identity.ID,
  sessionID: Identity.ID,
  localSequence: Identity.Revision,
  event: Sync.Event,
  queuedAt: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
export type Draft = z.infer<typeof Draft>

export const ProjectionRecord = z.strictObject({
  schemaVersion: z.literal(1),
  draftID: Identity.ID,
  localSequence: Identity.Revision,
  event: Sync.Event,
})
export type ProjectionRecord = z.infer<typeof ProjectionRecord>

export const Batch = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  bindingEpoch: Protocol.Epoch,
  shareGeneration: Identity.Revision,
  firstSeq: Sync.Sequence,
  lastSeq: Sync.Sequence,
  payloadHash: Protocol.Digest,
  draftIDs: z.array(Identity.ID).min(1).max(256),
  draftHashes: z.array(Protocol.Digest).min(1).max(256).optional(),
  events: z.array(Sync.Event).min(1).max(256),
})
export type Batch = z.infer<typeof Batch>

type DraftIdentity =
  | { type: "session"; sessionID: string }
  | { type: "message"; sessionID: string; messageID: string }
  | { type: "part"; sessionID: string; partID: string }
  | { type: "tool"; sessionID: string; callID: string }
  | { type: "attachment"; sessionID: string; attachmentID: string }
  | { type: "cortex"; sessionID: string; taskID: string }
  | { type: "notification"; sessionID: string; notificationID: string }
  | { type: "blob"; sessionID: string; blobID: string; kind?: Extract<Sync.Event, { type: "blob" }>["kind"] }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export function draftID(value: DraftIdentity) {
  return digest(value).slice(0, 32)
}
export function eventDraftID(rootSessionID: string, value: Sync.Event): string {
  if (value.type === "session") return draftID({ type: "session", sessionID: value.session.sessionID })
  const sessionID = value.sessionID ?? rootSessionID
  switch (value.type) {
    case "message":
      return draftID({ type: "message", sessionID, messageID: value.messageID })
    case "part":
      return draftID({ type: "part", sessionID, partID: value.partID })
    case "tool":
      return draftID({ type: "tool", sessionID, callID: value.callID })
    case "attachment":
      return draftID({ type: "attachment", sessionID, attachmentID: value.attachmentID })
    case "cortex":
      return draftID({ type: "cortex", sessionID, taskID: value.taskID })
    case "notification":
      return draftID({ type: "notification", sessionID, notificationID: value.notificationID })
    case "blob":
      return draftID({
        type: "blob",
        sessionID,
        blobID: value.blobID,
        ...(value.kind === "message-content" ? {} : { kind: value.kind }),
      })
  }
}
export function sequenceDraftEvent(input: Sync.Event, sequence: number, shareGeneration: number) {
  const event = { ...input, sequence }
  if (event.type === "session") event.session = { ...event.session, shareGeneration }
  return Sync.Event.parse(event)
}
export function originalBatch(value: unknown, projectID: string) {
  const stored = Batch.parse(value)
  const identity = Sync.BatchIdentity.parse({
    sessionID: stored.sessionID,
    projectID,
    bindingEpoch: stored.bindingEpoch,
    shareGeneration: stored.shareGeneration,
    firstSeq: stored.firstSeq,
    lastSeq: stored.lastSeq,
    payloadHash: stored.payloadHash,
  })
  const sent = Sync.Batch.parse({ schemaVersion: 1, ...identity, events: stored.events })
  if (
    !stored.draftHashes ||
    stored.draftHashes.length !== stored.draftIDs.length ||
    stored.draftIDs.length !== sent.events.length ||
    new Set(stored.draftIDs).size !== stored.draftIDs.length ||
    digest({ firstSeq: sent.firstSeq, lastSeq: sent.lastSeq, events: sent.events }) !== sent.payloadHash
  )
    throw new Error("Original sync batch lacks its immutable body and original draft identities")
  for (const [index, event] of sent.events.entries()) {
    const original = sequenceDraftEvent(event, 1, 0)
    if (
      stored.draftIDs[index] !== eventDraftID(stored.sessionID, original) ||
      stored.draftHashes[index] !== digest(original)
    )
      throw new Error("Original sync batch differs from its original draft content or identity")
  }
  return { stored, sent, identity }
}

export type DraftInput = { draftID: string; event: Sync.Event }
export type Bound = NonNullable<Awaited<ReturnType<typeof binding>>>
export interface WriteOwner {
  check(): Promise<void>
  assertCurrent(): void
  afterFailure?(originalError: unknown): undefined
}

async function storedSession(sessionID: string, scopeID: string | undefined, incomplete: boolean) {
  if (incomplete && scopeID !== undefined) {
    const present = await Core.storedInfoIfComplete({ scopeID, sessionID })
    return present ? Session.Info.parse({ ...present.raw, workspace: null }) : undefined
  }
  const indexKey = StoragePath.sessionIndex(Identifier.asSessionID(sessionID))
  const [index] = await Storage.readMany([indexKey])
  if (index === undefined) {
    if (scopeID && !incomplete) {
      const [value] = await Storage.readMany([
        StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
      ])
      if (value !== undefined) await Core.storedInfo({ scopeID, sessionID })
    }
    return
  }
  const selected = z.object({ scopeID: z.string().min(1) }).parse(index)
  if (scopeID !== undefined && scopeID !== selected.scopeID)
    throw new Error("Native shared binding index changed its actual Scope")
  if (incomplete) {
    const [value] = await Storage.readMany([
      StoragePath.sessionInfo(Identifier.asScopeID(selected.scopeID), Identifier.asSessionID(sessionID)),
    ])
    if (value === undefined) return
  }
  const { raw } = await Core.storedInfo({ scopeID: selected.scopeID, sessionID })
  return Session.Info.parse({ ...raw, workspace: null })
}

export function binding(sessionID: string, orgID: string, scopeID?: string) {
  return Storage.snapshot(() => resolveBinding(sessionID, orgID, scopeID, false))
}

/** Before a native creation pair exists, diagnostics have no committed owner to attribute. */
export function mutationBinding(sessionID: string, orgID: string, scopeID?: string) {
  return Storage.snapshot(() => resolveBinding(sessionID, orgID, scopeID, true))
}

async function resolveBinding(sessionID: string, orgID: string, scopeID: string | undefined, incomplete: boolean) {
  const initial = await storedSession(sessionID, scopeID, incomplete)
  if (!initial) return
  const chain: Session.Info[] = []
  const visited = new Set<string>()
  let current = initial
  while (true) {
    if (!visited.add(current.id)) return
    chain.push(current)
    if (!current.parentID) break
    if (!current.cortex || current.cortex.parentSessionID !== current.parentID) return
    const parent = await storedSession(current.parentID, current.scope.id, false)
    if (!parent) return
    current = parent
  }
  const root = chain.at(-1)!
  const binding = root.organization
  if (
    !binding ||
    binding.orgID !== orgID ||
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

function sameDraft(value: Draft | ProjectionRecord | undefined, rootSessionID: string, input: DraftInput) {
  return (
    value !== undefined &&
    value.draftID === input.draftID &&
    (!("sessionID" in value) ||
      (value.sessionID === rootSessionID && value.bytes === Buffer.byteLength(JSON.stringify(input.event)))) &&
    JSON.stringify(value.event) === JSON.stringify(input.event)
  )
}

export async function putDrafts(bound: Bound, inputs: readonly DraftInput[], owner: WriteOwner) {
  const rootSessionID = bound.rootSessionID
  const identity = { orgID: bound.binding.orgID }
  if (!inputs.length) return
  for (let offset = 0; offset < inputs.length; offset += 128) {
    const window = inputs.slice(offset, offset + 128)
    await owner.check()
    const drafts = await Storage.readMany<unknown>(
      window.map((entry) => Keys.draft(identity.orgID, rootSessionID, entry.draftID)),
    )
    const projections = await Storage.readMany<unknown>(
      window.map((entry) => Keys.projection(identity.orgID, rootSessionID, entry.draftID)),
    )
    const changed = window.some(
      (entry, index) =>
        !sameDraft(
          drafts[index] === undefined
            ? projections[index] === undefined
              ? undefined
              : ProjectionRecord.parse(projections[index])
            : Draft.parse(drafts[index]),
          rootSessionID,
          entry,
        ),
    )
    if (!changed) {
      await owner.check()
      continue
    }
    await Storage.transaction(
      async (tx) => {
        if (owner.afterFailure) Storage.afterFailure(owner.afterFailure)
        await owner.check()
        const current = await read(State, Keys.state(identity.orgID, rootSessionID))
        const originalDrafts = await tx.readMany<unknown>(
          window.map((entry) => Keys.draft(identity.orgID, rootSessionID, entry.draftID)),
        )
        const originalProjections = await tx.readMany<unknown>(
          window.map((entry) => Keys.projection(identity.orgID, rootSessionID, entry.draftID)),
        )
        const prepared = new Map<string, { draft: Draft; projection: ProjectionRecord }>()
        let nextDraft = current?.nextDraft ?? 1
        for (const [index, input] of window.entries()) {
          const pending = prepared.get(input.draftID)
          const previous =
            pending?.draft ?? (originalDrafts[index] === undefined ? undefined : Draft.parse(originalDrafts[index]))
          const retained =
            previous ??
            (originalProjections[index] === undefined ? undefined : ProjectionRecord.parse(originalProjections[index]))
          if (sameDraft(retained, rootSessionID, input)) continue
          const localSequence = retained?.localSequence ?? nextDraft
          nextDraft = Math.max(nextDraft, localSequence + 1)
          const event = Sync.Event.parse({ ...input.event, sequence: 1 })
          prepared.set(input.draftID, {
            draft: Draft.parse({
              schemaVersion: 1,
              draftID: input.draftID,
              sessionID: rootSessionID,
              localSequence,
              event,
              queuedAt: previous?.queuedAt ?? Date.now(),
              bytes: Buffer.byteLength(JSON.stringify(event)),
            }),
            projection: ProjectionRecord.parse({
              schemaVersion: 1,
              draftID: input.draftID,
              localSequence,
              event,
            }),
          })
        }
        if (!prepared.size) return
        await tx.writeMany(
          [...prepared].flatMap(([draftID, value]) => [
            { key: Keys.draft(identity.orgID, rootSessionID, draftID), value: value.draft },
            { key: Keys.projection(identity.orgID, rootSessionID, draftID), value: value.projection },
            { key: Keys.orderedDraft(identity.orgID, rootSessionID, value.draft.localSequence), value: { draftID } },
          ]),
        )
        await Storage.write(
          Keys.state(identity.orgID, rootSessionID),
          State.parse({
            schemaVersion: 1,
            orgID: identity.orgID,
            sessionID: rootSessionID,
            nextDraft,
            shareGeneration: current?.shareGeneration,
            projectionVersion: current?.projectionVersion,
            syncState: current?.syncState === "failed" ? "pending" : (current?.syncState ?? "pending"),
            updatedAt: Date.now(),
          }),
        )
        await Storage.write(Keys.registeredRoot(identity.orgID, rootSessionID), { sessionID: rootSessionID })
      },
      { commitGuard: owner.assertCurrent },
    )
  }
}
