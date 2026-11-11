import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"

export namespace OrganizationSyncProtocol {
  export const Sequence = z.number().int().positive()
  export const TokenUsage = z.strictObject({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.strictObject({ read: z.number(), write: z.number() }),
  })
  export const KnowledgeToolMetadata = z.strictObject({
    operation: z.enum(["list", "files", "read", "search"]).optional(),
    itemID: Identity.ID.optional(),
    version: Identity.Revision.optional(),
    manifestHash: Protocol.Digest.optional(),
    fileID: Identity.ID.optional(),
    path: z.string().max(2048).optional(),
    title: z.string().max(1024).optional(),
    offset: Identity.Revision.optional(),
    bytes: Identity.Revision.optional(),
    truncated: z.boolean().optional(),
    cursor: z.string().max(2048).optional(),
  })

  export const Content = z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("inline"),
        text: z
          .string()
          .refine(
            (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
            "Inline content exceeds its transport window",
          ),
      }),
      z.strictObject({
        kind: z.literal("blob"),
        blobID: Identity.ID,
        hash: Protocol.Digest,
        bytes: z.number().int().nonnegative().safe(),
        mediaType: z.string().min(1).max(256),
      }),
    ])
    .meta({ ref: "OrgTranscriptContent" })
  export type Content = z.infer<typeof Content>

  export function transcriptPartSchema<C extends z.ZodType>(content: C) {
    return z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("text"), content, origin: z.enum(["user", "system"]).optional() }),
      z.strictObject({
        type: z.literal("reasoning"),
        content,
        time: z.strictObject({ start: z.number(), end: z.number().optional() }).optional(),
      }),
      z.strictObject({
        type: z.literal("tool"),
        callID: Identity.ID,
        tool: z.string().min(1).max(256),
        status: z.enum(["pending", "generating", "running", "completed", "error"]),
        input: content,
        output: content.optional(),
        error: content.optional(),
        title: z.string().max(1024).optional(),
        startedAt: z.number().nonnegative().optional(),
        completedAt: z.number().nonnegative().optional(),
        metadata: KnowledgeToolMetadata.optional(),
      }),
      z.strictObject({
        type: z.literal("attachment"),
        filename: z.string().min(1).max(512),
        mediaType: z.string().min(1).max(256),
        hash: Protocol.Digest.optional(),
        bytes: z.number().int().nonnegative().optional(),
      }),
      z.strictObject({ type: z.literal("step-start") }),
      z.strictObject({
        type: z.literal("step-finish"),
        reason: z.string().max(256),
        cost: z.number(),
        tokens: TokenUsage.optional(),
      }),
      z.strictObject({ type: z.literal("compaction"), auto: z.boolean() }),
      z.strictObject({ type: z.literal("notice"), kind: z.string().min(1).max(256), content }),
    ])
  }
  export const TranscriptPart = transcriptPartSchema(Content).meta({ ref: "OrgTranscriptPart" })
  export type TranscriptPart = z.infer<typeof TranscriptPart>

  export const ShareChange = z
    .strictObject({ expectedShareGeneration: Identity.Revision })
    .meta({ ref: "OrgShareChange" })
  export type ShareChange = z.infer<typeof ShareChange>

  export const SyncState = z.enum(["pending", "syncing", "synced", "blocked", "failed"])

  export const CortexStatus = z.enum(["queued", "running", "completed", "error", "cancelled", "interrupted"])
  const statusObservation = {
    observedAt: z.number().int().nonnegative(),
    controlVersion: Identity.Revision,
    runID: Identity.ID.optional(),
  }
  export const Status = z.discriminatedUnion("type", [
    z.strictObject({ ...statusObservation, type: z.literal("idle") }),
    z.strictObject({ ...statusObservation, type: z.literal("busy") }),
    z.strictObject({
      ...statusObservation,
      type: z.literal("paused"),
      since: z.number(),
      reason: z.enum(["aborted", "failed", "interrupted", "workflow"]),
    }),
    z.strictObject({
      ...statusObservation,
      type: z.literal("retry"),
      attempt: z.number(),
      next: z.number().optional(),
    }),
  ])
  export type Status = z.infer<typeof Status>

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

  export const TaskSummary = CortexProjection.omit({ visibility: true }).extend({
    sessionID: Identity.ID,
    deliveryNotifiedAt: z.number().int().nonnegative().optional(),
    agent: z.string().max(256).optional(),
    model: z.strictObject({ providerID: z.string().max(256), modelID: z.string().max(512) }).optional(),
    category: z.string().max(512).optional(),
  }).meta({ ref: "OrgTaskSummary" })
  export type TaskSummary = z.infer<typeof TaskSummary>

  export const SessionProjection = z.strictObject({
    sessionID: Identity.ID,
    projectID: Identity.ID,
    creatorID: Identity.ID,
    driverRuntimeID: Identity.ID,
    bindingEpoch: Protocol.Epoch,
    createdAt: z.number().int().nonnegative(),
    shareGeneration: Identity.Revision,
    title: z.string().max(512).optional(),
    status: Status.optional(),
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
  export const MessageEvent = z.strictObject({
    type: z.literal("message"),
    sequence: Sequence,
    sessionID: Identity.ID.optional(),
    messageID: Identity.ID,
    role: z.enum(["user", "assistant"]),
    createdAt: z.number().int().nonnegative(),
    summary: z.string().max(32 * 1024),
    actor: ActorStamp.Info.optional(),
    agent: z.string().max(256).optional(),
    parentID: Identity.ID.optional(),
    rootID: Identity.ID.optional(),
    completedAt: z.number().int().nonnegative().optional(),
    finish: z.string().max(256).optional(),
    model: z.strictObject({ providerID: z.string().max(256), modelID: z.string().max(512) }).optional(),
    mode: z.string().max(256).optional(),
    cost: z.number().finite().optional(),
    tokens: TokenUsage.optional(),
    error: z.strictObject({ code: z.string().max(256), message: z.string().max(32 * 1024) }).optional(),
    removed: z.literal(true).optional(),
    integrity: Protocol.Digest,
  })
  export const PartEvent = z
    .strictObject({
      type: z.literal("part"),
      sequence: Sequence,
      sessionID: Identity.ID.optional(),
      messageID: Identity.ID,
      partID: Identity.ID,
      part: TranscriptPart.optional(),
      removed: z.literal(true).optional(),
      integrity: Protocol.Digest,
    })
    .refine(
      (value) => (value.removed ? value.part === undefined : value.part !== undefined),
      "A transcript part must contain content or a deletion",
    )
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
    agent: TaskSummary.shape.agent,
    model: TaskSummary.shape.model,
    category: TaskSummary.shape.category,
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
    kind: z.enum(["tool-input", "tool-output", "tool-observation", "cortex-output", "message-content"]),
    mediaType: z.string().min(1).max(256),
    bytes: z.number().int().nonnegative(),
    hash: Protocol.Digest,
    state: z.enum(["uploading", "available", "missing", "failed"]),
  })
  export const Event = z
    .discriminatedUnion("type", [
      SessionEvent,
      MessageEvent,
      PartEvent,
      ToolEvent,
      AttachmentEvent,
      CortexEvent,
      NotificationEvent,
      BlobEvent,
    ])
    .meta({ ref: "OrgSyncEvent" })
  export type Event = z.infer<typeof Event>
  export const WindowCursor = z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[a-zA-Z0-9_-]+$/)
  export const MessageQuery = z.strictObject({
    latest: z
      .union([z.boolean(), z.literal("true").transform(() => true), z.literal("false").transform(() => false)])
      .optional(),
    sourceSessionID: Identity.ID.optional(),
    limit: z.coerce.number().int().min(1).max(64).default(32),
    cursor: WindowCursor.optional(),
    watermark: z.coerce.number().int().nonnegative().safe().optional(),
  })
  export type MessageQuery = z.input<typeof MessageQuery>
  export const TaskQuery = MessageQuery.omit({ latest: true })
  export type TaskQuery = z.input<typeof TaskQuery>
  export const PartQuery = MessageQuery.extend({
    messageID: Identity.ID,
    limit: z.coerce.number().int().min(1).max(128).default(64),
  })
  export type PartQuery = z.input<typeof PartQuery>
  const window = {
    sessionID: Identity.ID,
    sourceSessionID: Identity.ID,
    shareGeneration: Identity.Revision,
    watermark: Identity.Revision,
    cursor: WindowCursor.optional(),
  }
  export const MessagePage = z
    .strictObject({ ...window, items: z.array(MessageEvent).max(64) })
    .meta({ ref: "OrgSharedMessagePage" })
  export const PartPage = z
    .strictObject({ ...window, messageID: Identity.ID, items: z.array(PartEvent).max(128), complete: z.boolean() })
    .meta({ ref: "OrgSharedPartPage" })
  export const TaskPage = z
    .strictObject({ ...window, items: z.array(TaskSummary).max(64) })
    .meta({ ref: "OrgSharedTaskPage" })

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

  export const SnapshotQuery = z.strictObject({
    limit: z.coerce.number().int().min(1).max(256).default(128),
    cursor: Identity.ID.optional(),
    watermark: Identity.Revision.optional(),
  })
  export type SnapshotQuery = z.infer<typeof SnapshotQuery>
  export const SnapshotPage = z
    .strictObject({
      sessionID: Identity.ID,
      shareGeneration: Identity.Revision,
      watermark: Identity.Revision,
      items: z.array(Event).max(256),
      cursor: Identity.ID.optional(),
    })
    .meta({ ref: "OrgTranscriptSnapshotPage" })
  export type SnapshotPage = z.infer<typeof SnapshotPage>

  export const SearchQuery = z.strictObject({
    q: z.string().trim().min(1).max(256),
    limit: z.coerce.number().int().min(1).max(64).default(32),
    cursor: Identity.Revision.optional(),
  })
  export type SearchQuery = z.infer<typeof SearchQuery>

  export const SearchHit = z.strictObject({
    sequence: Sequence,
    sessionID: Identity.ID,
    kind: z.enum(["session", "message", "part", "tool", "attachment", "cortex", "notification", "blob"]),
    id: Identity.ID,
    snippet: z.string().max(512),
    integrity: Protocol.Digest,
  })
  export type SearchHit = z.infer<typeof SearchHit>

  export const SearchPage = z
    .strictObject({
      sessionID: Identity.ID,
      shareGeneration: Identity.Revision,
      nextSeq: Identity.Revision,
      items: z.array(SearchHit).max(64),
      cursor: Identity.Revision.optional(),
    })
    .meta({ ref: "OrgSyncSearchPage" })
  export type SearchPage = z.infer<typeof SearchPage>

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
