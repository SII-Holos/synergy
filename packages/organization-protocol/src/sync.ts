import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"

export namespace OrganizationSyncProtocol {
  export const Sequence = z.number().int().positive()

  export const ShareChange = z
    .strictObject({ expectedShareGeneration: Identity.Revision })
    .meta({ ref: "OrgShareChange" })
  export type ShareChange = z.infer<typeof ShareChange>

  export const SyncState = z.enum(["pending", "syncing", "synced", "blocked", "failed"])

  export const CortexStatus = z.enum(["queued", "running", "completed", "error", "cancelled", "interrupted"])

  export const CortexProjection = z.strictObject({
    taskID: Identity.ID,
    parentSessionID: Identity.ID,
    parentMessageID: Identity.ID,
    status: CortexStatus,
    description: z.string().max(512),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    notifyParentOnComplete: z.boolean().optional(),
    visibility: z.enum(["visible", "hidden"]).optional(),
  })
  export type CortexProjection = z.infer<typeof CortexProjection>

  export const SessionProjection = z.strictObject({
    sessionID: Identity.ID,
    projectID: Identity.ID,
    creatorID: Identity.ID,
    driverRuntimeID: Identity.ID,
    bindingEpoch: Protocol.Epoch,
    createdAt: z.number().int().nonnegative(),
    shareGeneration: Identity.Revision,
    rootSessionID: Identity.ID.optional(),
    parentSessionID: Identity.ID.optional(),
    cortex: CortexProjection.optional(),
  })
  export type SessionProjection = z.infer<typeof SessionProjection>

  const SessionEvent = z.strictObject({
    type: z.literal("session"),
    sequence: Sequence,
    session: SessionProjection,
  })
  const MessageEvent = z.strictObject({
    type: z.literal("message"),
    sequence: Sequence,
    sessionID: Identity.ID.optional(),
    messageID: Identity.ID,
    role: z.enum(["user", "assistant"]),
    createdAt: z.number().int().nonnegative(),
    summary: z.string().max(32 * 1024),
    integrity: Protocol.Digest,
  })
  const ToolEvent = z.strictObject({
    type: z.literal("tool"),
    sequence: Sequence,
    sessionID: Identity.ID.optional(),
    callID: Identity.ID,
    name: z.string().min(1).max(256),
    state: z.enum(["pending", "running", "completed", "error", "unknown"]),
    summary: z.string().max(32 * 1024),
    integrity: Protocol.Digest,
  })
  const AttachmentEvent = z.strictObject({
    type: z.literal("attachment"),
    sequence: Sequence,
    sessionID: Identity.ID.optional(),
    attachmentID: Identity.ID,
    filename: z.string().min(1).max(512),
    mediaType: z.string().min(1).max(256),
    bytes: z.number().int().nonnegative(),
    hash: Protocol.Digest,
    state: z.enum(["pending", "uploading", "available", "missing", "failed"]),
  })
  const CortexEvent = z.strictObject({
    type: z.literal("cortex"),
    sequence: Sequence,
    sessionID: Identity.ID,
    taskID: Identity.ID,
    parentSessionID: Identity.ID,
    parentMessageID: Identity.ID,
    status: CortexStatus,
    description: z.string().max(512),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    notifyParentOnComplete: z.boolean().optional(),
    deliveryNotifiedAt: z.number().int().nonnegative().optional(),
    summary: z.string().max(32 * 1024),
    integrity: Protocol.Digest,
  })
  const NotificationEvent = z.strictObject({
    type: z.literal("notification"),
    sequence: Sequence,
    sessionID: Identity.ID,
    notificationID: Identity.ID,
    kind: z.literal("cortex-completion"),
    taskID: Identity.ID,
    childSessionID: Identity.ID,
    status: CortexStatus,
    createdAt: z.number().int().nonnegative(),
    summary: z.string().max(32 * 1024),
    integrity: Protocol.Digest,
  })
  const BlobEvent = z.strictObject({
    type: z.literal("blob"),
    sequence: Sequence,
    sessionID: Identity.ID.optional(),
    blobID: Identity.ID,
    kind: z.enum(["tool-input", "tool-output", "tool-observation", "cortex-output"]),
    mediaType: z.string().min(1).max(256),
    bytes: z.number().int().nonnegative(),
    hash: Protocol.Digest,
    state: z.enum(["uploading", "available", "missing", "failed"]),
  })
  export const Event = z
    .discriminatedUnion("type", [
      SessionEvent,
      MessageEvent,
      ToolEvent,
      AttachmentEvent,
      CortexEvent,
      NotificationEvent,
      BlobEvent,
    ])
    .meta({ ref: "OrgSyncEvent" })
  export type Event = z.infer<typeof Event>

  export const Batch = z
    .strictObject({
      schemaVersion: z.literal(1),
      sessionID: Identity.ID,
      projectID: Identity.ID,
      bindingEpoch: Protocol.Epoch,
      shareGeneration: Identity.Revision,
      firstSeq: Sequence,
      lastSeq: Sequence,
      payloadHash: Protocol.Digest,
      events: z.array(Event).min(1).max(256),
    })
    .refine((value) => value.firstSeq <= value.lastSeq, "Sync batch sequence range is invalid")
    .refine(
      (value) =>
        value.events.length === value.lastSeq - value.firstSeq + 1 &&
        value.events.every((event, index) => event.sequence === value.firstSeq + index),
      "Sync batch events must be contiguous",
    )
    .meta({ ref: "OrgSyncBatch" })
  export type Batch = z.infer<typeof Batch>

  export const Ack = z
    .strictObject({
      sessionID: Identity.ID,
      bindingEpoch: Protocol.Epoch,
      shareGeneration: Identity.Revision,
      nextSeq: Identity.Revision,
      syncState: SyncState,
    })
    .meta({ ref: "OrgSyncAck" })
  export type Ack = z.infer<typeof Ack>

  export const Share = z
    .strictObject({
      sessionID: Identity.ID,
      shareState: z.enum(["private", "shared"]),
      shareGeneration: Identity.Revision,
      bindingEpoch: Protocol.Epoch,
      nextSeq: Identity.Revision,
      syncState: SyncState,
      updatedAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgShareView" })
  export type Share = z.infer<typeof Share>

  export const EventPage = z
    .strictObject({
      sessionID: Identity.ID,
      shareGeneration: Identity.Revision,
      nextSeq: Identity.Revision,
      items: z.array(Event).max(256),
      cursor: Identity.Revision.optional(),
    })
    .meta({ ref: "OrgSyncEventPage" })
  export type EventPage = z.infer<typeof EventPage>

  export const EventPageQuery = z.strictObject({
    limit: z.coerce.number().int().min(1).max(256).default(256),
    cursor: Identity.Revision.optional(),
  })
  export type EventPageQuery = z.infer<typeof EventPageQuery>

  export const BlobStatus = z
    .strictObject({
      sessionID: Identity.ID,
      shareGeneration: Identity.Revision,
      hash: Protocol.Digest,
      bytes: z.number().int().nonnegative(),
      chunkBytes: z.literal(4 * 1024 * 1024),
      receivedBytes: z.number().int().nonnegative(),
      complete: z.boolean(),
      nextOffset: z.number().int().nonnegative().optional(),
    })
    .meta({ ref: "OrgSyncBlobStatus" })
  export type BlobStatus = z.infer<typeof BlobStatus>
}
