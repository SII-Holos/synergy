import z from "zod"
import { MAX_SEGMENT_LENGTH } from "./keys"
import type { SessionEndpoint } from "@/session/endpoint"
import { canonicalHash } from "@/util/canonical"

export const ClarusIdSchema = z.string().min(1).max(MAX_SEGMENT_LENGTH)

export const ClarusProjectLifecycle = z.enum(["active", "archived", "exited", "revoked", "deleted"])
export type ClarusProjectLifecycle = z.infer<typeof ClarusProjectLifecycle>

// --- Project Binding V3 (canonical) ---

export const ClarusProjectBindingV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    agentId: ClarusIdSchema,
    projectId: ClarusIdSchema,
    lifecycle: ClarusProjectLifecycle,
    projectName: z.string().optional(),
    projectSlug: z.string().optional(),
    projectStatus: z.string().optional(),
    membership: z.string().optional(),
    primaryAgent: z.string().nullable().optional(),
    desiredSubscription: z.boolean(),
    messageCursor: z.string().nullable().optional(),
    lastProjectActivityAt: z.number().optional(),
    lastReconciliationAt: z.number().optional(),
    lastReconciliationError: z.string().nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()
export type ClarusProjectBindingV3 = z.infer<typeof ClarusProjectBindingV3Schema>

// --- Task Binding V4 (canonical) ---

export const ClarusAssignmentStateV4Schema = z.enum(["planned", "enqueued", "materialized", "processing"])
export type ClarusAssignmentStateV4 = z.infer<typeof ClarusAssignmentStateV4Schema>

export const ClarusTaskStatusV4Schema = z.enum([
  "waiting",
  "running",
  "needs_attention",
  "submitting",
  "submitted",
  "failed",
  "expired",
  "cancelled",
])
export type ClarusTaskStatusV4 = z.infer<typeof ClarusTaskStatusV4Schema>

export const ClarusResultStateV4Schema = z.enum([
  "idle",
  "not_dispatched",
  "prepared",
  "dispatched",
  "acknowledged",
  "ambiguous",
  "rejected",
  "local_only",
])
export type ClarusResultStateV4 = z.infer<typeof ClarusResultStateV4Schema>

export const ClarusTaskContextHydrationSchema = z.enum(["complete", "partial", "unavailable"])
export type ClarusTaskContextHydration = z.infer<typeof ClarusTaskContextHydrationSchema>

export const ClarusTaskSessionOwnershipClaimSchema = z.object({
  claimedByScopeID: z.string(),
  claimedAt: z.number(),
  resolvedAt: z.number().optional(),
})
export type ClarusTaskSessionOwnershipClaim = z.infer<typeof ClarusTaskSessionOwnershipClaimSchema>

export const ClarusTaskBindingV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    agentId: ClarusIdSchema,
    projectId: ClarusIdSchema,
    taskId: ClarusIdSchema,
    sessionID: z.string(),
    workspacePath: z.string(),
    scopeID: z.string(),
    runID: z.string(),
    subtaskID: z.string(),
    phase: z.string(),
    attempt: z.number().int().nonnegative(),
    deadlineAt: z.string().nullable().optional(),
    title: z.string().min(1),
    taskInput: z.record(z.string(), z.unknown()),
    contextHydration: ClarusTaskContextHydrationSchema,
    frozenAgent: z.string(),
    assignmentState: ClarusAssignmentStateV4Schema,
    assignmentInboxItemID: z.string(),
    assignmentMessageID: z.string(),
    status: ClarusTaskStatusV4Schema,
    resultState: ClarusResultStateV4Schema,
    resultOutboxRequestID: z.string().optional(),
    resultRecordedAt: z.number().optional(),
    lastCompletedAssistantMessageID: z.string().optional(),
    localContinuationEnabledAt: z.number().optional(),
    materializedAt: z.number().optional(),
    taskSessionOwnershipClaim: ClarusTaskSessionOwnershipClaimSchema.optional(),
    extendOutboxRequestIDs: z.array(z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()
export type ClarusTaskBindingV4 = z.infer<typeof ClarusTaskBindingV4Schema>

// --- Legacy schemas for migration only ---

export const ClarusBindingV1Schema = z.object({
  schemaVersion: z.literal(1),
  agentId: ClarusIdSchema,
  projectId: ClarusIdSchema,
  state: z.enum(["active", "inactive"]),
  workspacePath: z.string(),
  scopeID: z.string(),
  projectSessionID: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const ClarusBindingV2Schema = z.object({
  schemaVersion: z.literal(2),
  agentId: ClarusIdSchema,
  projectId: ClarusIdSchema,
  lifecycle: ClarusProjectLifecycle,
  workspacePath: z.string(),
  scopeID: z.string(),
  projectSessionID: z.string(),
  projectName: z.string().optional(),
  projectSlug: z.string().optional(),
  projectStatus: z.string().optional(),
  primaryAgent: z.string().nullable().optional(),
  desiredSubscription: z.boolean(),
  messageCursor: z.string().nullable().optional(),
  lastReconciliationAt: z.number().optional(),
  lastReconciliationError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ClarusBindingV2 = z.infer<typeof ClarusBindingV2Schema>

export const ClarusBindingSchema = z.union([ClarusBindingV1Schema, ClarusBindingV2Schema])
export type ClarusBinding = z.infer<typeof ClarusBindingSchema>

export const ClarusTaskBindingV1Schema = z.object({
  schemaVersion: z.literal(1),
  agentId: ClarusIdSchema,
  projectId: ClarusIdSchema,
  taskId: ClarusIdSchema,
  sessionID: z.string(),
  workspacePath: z.string(),
  scopeID: z.string(),
  status: z.enum(["assigned"]).default("assigned"),
  assignmentState: z.enum(["planned", "enqueued"]).optional(),
  assignmentInboxItemID: z.string().optional(),
  assignmentMessageID: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const ClarusTaskBindingV2Schema = z.object({
  schemaVersion: z.literal(2),
  agentId: ClarusIdSchema,
  projectId: ClarusIdSchema,
  taskId: ClarusIdSchema,
  sessionID: z.string(),
  workspacePath: z.string(),
  scopeID: z.string(),
  status: z.enum(["assigned", "completed", "cancelled"]).default("assigned"),
  assignmentState: z.enum(["planned", "enqueued"]).optional(),
  assignmentInboxItemID: z.string().optional(),
  assignmentMessageID: z.string().optional(),
  runID: z.string().optional(),
  phase: z.string().optional(),
  subtaskID: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  deadlineAt: z.string().nullable().optional(),
  remoteStatus: z.string().optional(),
  taskInput: z.record(z.string(), z.unknown()).optional(),
  frozenAgent: z.string().optional(),
  resultOutboxRequestID: z.string().optional(),
  extendOutboxRequestIDs: z.array(z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ClarusTaskBindingV2 = z.infer<typeof ClarusTaskBindingV2Schema>

export const ClarusTaskBindingV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    agentId: ClarusIdSchema,
    projectId: ClarusIdSchema,
    taskId: ClarusIdSchema,
    sessionID: z.string(),
    workspacePath: z.string(),
    scopeID: z.string(),
    runID: z.string(),
    subtaskID: z.string(),
    phase: z.string(),
    attempt: z.number().int().nonnegative(),
    deadlineAt: z.string().nullable().optional(),
    title: z.string().min(1),
    taskInput: z.record(z.string(), z.unknown()),
    contextHydration: ClarusTaskContextHydrationSchema,
    frozenAgent: z.string(),
    assignmentState: z.enum(["planned", "enqueued", "processing"]),
    assignmentInboxItemID: z.string().optional(),
    assignmentMessageID: z.string().optional(),
    status: z.enum([
      "waiting",
      "running",
      "needs_attention",
      "submitting",
      "submitted",
      "failed",
      "expired",
      "cancelled",
    ]),
    resultOutboxRequestID: z.string().optional(),
    resultRecordedAt: z.number().optional(),
    localContinuationEnabledAt: z.number().optional(),
    extendOutboxRequestIDs: z.array(z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()
export type ClarusTaskBindingV3 = z.infer<typeof ClarusTaskBindingV3Schema>

export const ClarusTaskBindingSchema = z.union([
  ClarusTaskBindingV1Schema,
  ClarusTaskBindingV2Schema,
  ClarusTaskBindingV3Schema,
])
export type ClarusTaskBinding = z.infer<typeof ClarusTaskBindingSchema>

// --- Dedup ---

export const ClarusMessageDedupEntryV1 = z.object({
  sessionID: z.string(),
  inboxItemID: z.string(),
})

export const ClarusInjectedDedup = z.object({
  outcome: z.literal("injected"),
  sessionID: z.string(),
  inboxItemID: z.string(),
})

export const ClarusActivityOnlyDedup = z.object({
  outcome: z.literal("activity_only"),
})

export const ClarusMessageDedupEntryV2 = z.discriminatedUnion("outcome", [ClarusInjectedDedup, ClarusActivityOnlyDedup])
export type ClarusMessageDedupEntry = z.infer<typeof ClarusMessageDedupEntryV2>

export type ClarusDelivery = ClarusMessageDedupEntry

// --- Outbox V2 ---

export const ClarusOutboxAction = z.enum([
  "project_subscribe",
  "project_unsubscribe",
  "project_message_send",
  "project_message",
  "task_extend",
  "task_result",
])
export type ClarusOutboxAction = z.infer<typeof ClarusOutboxAction>

export const ClarusOutboxStateV2 = z.enum([
  "prepared",
  "dispatched",
  "acknowledged",
  "not_dispatched",
  "rejected",
  "ambiguous",
  "local_only",
])
export type ClarusOutboxStateV2 = z.infer<typeof ClarusOutboxStateV2>

export const ClarusOutboxRecordV2 = z
  .object({
    schemaVersion: z.literal(2),
    requestID: z.string(),
    action: ClarusOutboxAction,
    agentId: ClarusIdSchema,
    projectId: ClarusIdSchema,
    taskId: ClarusIdSchema.optional(),
    runId: z.string().optional(),
    subtaskId: z.string().optional(),
    userId: ClarusIdSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
    payloadHash: z.string(),
    state: ClarusOutboxStateV2,
    connectionEpoch: z.string().optional(),
    generation: z.number().int().nonnegative().optional(),
    preparedAt: z.number(),
    dispatchedAt: z.number().optional(),
    acknowledgedAt: z.number().optional(),
    acknowledgedPayload: z.record(z.string(), z.unknown()).optional(),
    notDispatchedAt: z.number().optional(),
    rejectedAt: z.number().optional(),
    ambiguousAt: z.number().optional(),
    localOnlyAt: z.number().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict()
export type ClarusOutboxRecordV2 = z.infer<typeof ClarusOutboxRecordV2>

// Legacy V1 outbox for migration only
export const ClarusOutboxRecordV1 = z
  .object({
    schemaVersion: z.literal(1),
    requestID: z.string(),
    action: ClarusOutboxAction,
    agentId: ClarusIdSchema,
    projectId: ClarusIdSchema,
    taskId: ClarusIdSchema.optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    state: z.enum(["pending", "sent", "acknowledged", "ambiguous", "rejected"]),
    resolvedAt: z.number().optional(),
    resolvedBy: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()
export type ClarusOutboxRecordV1 = z.infer<typeof ClarusOutboxRecordV1>

export const ClarusOutboxRecordSchema = z.union([ClarusOutboxRecordV1, ClarusOutboxRecordV2])

// --- Payload Bound Constants ---

export const MAX_FILE_REFS = 50
export const MAX_FILE_REF_RECURSION_DEPTH = 8
export const MAX_METADATA_KEYS = 50
export const MAX_METADATA_KEY_LENGTH = 128
export const MAX_METADATA_RECURSION_DEPTH = 9
export const MAX_PAYLOAD_STRING_LENGTH = 8192
const MAX_INTERNAL_ARRAY_LENGTH = 50
export const MAX_PAYLOAD_AGGREGATE_BYTES = 65536

function checkAggregateBytes(data: unknown, limit: number): number {
  try {
    const len = new TextEncoder().encode(JSON.stringify(data)).byteLength
    return len > limit ? len : 0
  } catch {
    return 0
  }
}

function walkPayloadBounds(data: unknown, maxDepth: number, visited: WeakSet<object>, ctx: z.RefinementCtx): void {
  if (data === null || typeof data !== "object") {
    if (typeof data === "string" && data.length > MAX_PAYLOAD_STRING_LENGTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload string exceeds length limit" })
    }
    return
  }
  if (visited.has(data as object)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload contains a reference cycle" })
    return
  }
  visited.add(data as object)
  if (maxDepth <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload exceeds recursion depth limit" })
    return
  }
  if (Array.isArray(data)) {
    if (data.length > MAX_INTERNAL_ARRAY_LENGTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload array exceeds item limit" })
      return
    }
    for (const item of data) walkPayloadBounds(item, maxDepth - 1, visited, ctx)
  } else {
    const keys = Object.keys(data)
    if (keys.length > MAX_METADATA_KEYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload object exceeds key limit" })
      return
    }
    for (const key of keys) {
      if (key.length > MAX_METADATA_KEY_LENGTH) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload key exceeds length limit" })
        continue
      }
      walkPayloadBounds((data as Record<string, unknown>)[key], maxDepth - 1, visited, ctx)
    }
  }
}

export const BoundedFileRefsSchema = z
  .array(z.unknown())
  .max(MAX_FILE_REFS)
  .superRefine((data, ctx) => {
    const byteLen = checkAggregateBytes(data, MAX_PAYLOAD_AGGREGATE_BYTES)
    if (byteLen > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fileRefs aggregate bytes exceed budget" })
      return
    }
    walkPayloadBounds(data, MAX_FILE_REF_RECURSION_DEPTH, new WeakSet(), ctx)
  })

const BoundedMetadataSchema = z
  .record(z.string().max(MAX_METADATA_KEY_LENGTH), z.unknown())
  .superRefine((data, ctx) => {
    const keys = Object.keys(data)
    if (keys.length > MAX_METADATA_KEYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "metadata key count exceeds limit" })
      return
    }
    const byteLen = checkAggregateBytes(data, MAX_PAYLOAD_AGGREGATE_BYTES)
    if (byteLen > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "metadata aggregate bytes exceed budget" })
      return
    }
    walkPayloadBounds(data, MAX_METADATA_RECURSION_DEPTH, new WeakSet(), ctx)
  })

// --- Activity ---

export const ClarusProjectActivitySchema = z.object({
  agentId: ClarusIdSchema,
  projectId: ClarusIdSchema,
  messageId: ClarusIdSchema,
  senderType: z.string().optional(),
  senderId: z.string().optional(),
  messageType: z.string().optional(),
  content: z.string().optional(),
  fileRefs: BoundedFileRefsSchema.optional(),
  metadata: BoundedMetadataSchema.optional(),
  createdAt: z.string().optional(),
  receivedAt: z.number(),
})
export type ClarusProjectActivity = z.infer<typeof ClarusProjectActivitySchema>

// --- Reconciliation ---

export const ClarusReconciliationState = z.object({
  schemaVersion: z.literal(1),
  agentId: ClarusIdSchema,
  generation: z.number(),
  needsReconciliation: z.boolean(),
  lastReconciledAt: z.number().optional(),
  lastError: z.string().optional(),
  discoveryCursor: z.string().optional(),
  discoveryComplete: z.boolean().optional(),
})
export type ClarusReconciliationState = z.infer<typeof ClarusReconciliationState>

// --- Project Message Outbox Payload ---

export const ClarusProjectMessagePayloadSchema = z
  .object({
    content: z.string(),
    messageType: z.string().optional(),
    fileRefs: BoundedFileRefsSchema.optional(),
  })
  .strict()
export type ClarusProjectMessagePayload = z.infer<typeof ClarusProjectMessagePayloadSchema>

// --- Endpoint ---

export type ClarusEndpoint = Extract<SessionEndpoint.Info, { kind: "clarus" }>

// --- Config ---

export const ClarusConfig = z.object({
  workspaceRoot: z.string(),
})
export type ClarusConfig = z.infer<typeof ClarusConfig>

// --- Upgrade functions ---

export function upgradeBindingV1ToV3(v1: z.infer<typeof ClarusBindingV1Schema>): ClarusProjectBindingV3 {
  const lifecycle: ClarusProjectLifecycle = v1.state === "active" ? "active" : "archived"
  return ClarusProjectBindingV3Schema.parse({
    schemaVersion: 3,
    agentId: v1.agentId,
    projectId: v1.projectId,
    lifecycle,
    desiredSubscription: lifecycle === "active",
    messageCursor: null,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
  })
}

export function upgradeBindingV2ToV3(v2: ClarusBindingV2): ClarusProjectBindingV3 {
  return ClarusProjectBindingV3Schema.parse({
    schemaVersion: 3,
    agentId: v2.agentId,
    projectId: v2.projectId,
    lifecycle: v2.lifecycle,
    projectName: v2.projectName,
    projectSlug: v2.projectSlug,
    projectStatus: v2.projectStatus,
    primaryAgent: v2.primaryAgent,
    desiredSubscription: v2.desiredSubscription,
    messageCursor: v2.messageCursor,
    lastReconciliationAt: v2.lastReconciliationAt,
    lastReconciliationError: v2.lastReconciliationError,
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
  })
}

export function upgradeTaskBindingV1ToV4(v1: z.infer<typeof ClarusTaskBindingV1Schema>): ClarusTaskBindingV4 {
  return ClarusTaskBindingV4Schema.parse({
    schemaVersion: 4,
    agentId: v1.agentId,
    projectId: v1.projectId,
    taskId: v1.taskId,
    sessionID: v1.sessionID,
    workspacePath: v1.workspacePath,
    scopeID: v1.scopeID,
    runID: "",
    subtaskID: "",
    phase: "",
    attempt: 0,
    title: v1.taskId,
    taskInput: {},
    contextHydration: "unavailable",
    frozenAgent: "",
    assignmentState: "planned",
    assignmentInboxItemID: v1.assignmentInboxItemID ?? "",
    assignmentMessageID: v1.assignmentMessageID ?? "",
    status: "waiting",
    resultState: "idle",
    extendOutboxRequestIDs: [],
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
  })
}

export function upgradeTaskBindingV2ToV4(v2: ClarusTaskBindingV2): ClarusTaskBindingV4 {
  let status: ClarusTaskStatusV4
  switch (v2.status) {
    case "assigned":
      status = "waiting"
      break
    case "completed":
      status = v2.resultOutboxRequestID ? "submitted" : "needs_attention"
      break
    case "cancelled":
      status = "cancelled"
      break
    default:
      status = "waiting"
  }

  const hasRunInfo = !!(v2.runID && v2.taskInput)
  const contextHydration: ClarusTaskContextHydration = hasRunInfo ? "complete" : "unavailable"
  const title = v2.taskInput?.goal != null ? String(v2.taskInput.goal) : v2.taskId

  return ClarusTaskBindingV4Schema.parse({
    schemaVersion: 4,
    agentId: v2.agentId,
    projectId: v2.projectId,
    taskId: v2.taskId,
    sessionID: v2.sessionID,
    workspacePath: v2.workspacePath,
    scopeID: v2.scopeID,
    runID: v2.runID ?? "",
    subtaskID: v2.subtaskID ?? "",
    phase: v2.phase ?? "",
    attempt: v2.attempt ?? 0,
    title,
    taskInput: v2.taskInput ?? {},
    contextHydration,
    frozenAgent: v2.frozenAgent ?? "",
    assignmentState: "planned",
    assignmentInboxItemID: v2.assignmentInboxItemID ?? "",
    assignmentMessageID: v2.assignmentMessageID ?? "",
    status,
    resultState: "idle",
    resultOutboxRequestID: v2.resultOutboxRequestID,
    extendOutboxRequestIDs: v2.extendOutboxRequestIDs ?? [],
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
  })
}

export function upgradeTaskBindingV3ToV4(v3: ClarusTaskBindingV3): ClarusTaskBindingV4 {
  return ClarusTaskBindingV4Schema.parse({
    schemaVersion: 4,
    agentId: v3.agentId,
    projectId: v3.projectId,
    taskId: v3.taskId,
    sessionID: v3.sessionID,
    workspacePath: v3.workspacePath,
    scopeID: v3.scopeID,
    runID: v3.runID,
    subtaskID: v3.subtaskID,
    phase: v3.phase,
    attempt: v3.attempt,
    deadlineAt: v3.deadlineAt,
    title: v3.title,
    taskInput: v3.taskInput,
    contextHydration: v3.contextHydration,
    frozenAgent: v3.frozenAgent,
    assignmentState: v3.assignmentState as ClarusAssignmentStateV4,
    assignmentInboxItemID: v3.assignmentInboxItemID ?? "",
    assignmentMessageID: v3.assignmentMessageID ?? "",
    status: v3.status as ClarusTaskStatusV4,
    resultState: "idle",
    resultOutboxRequestID: v3.resultOutboxRequestID,
    resultRecordedAt: v3.resultRecordedAt,
    localContinuationEnabledAt: v3.localContinuationEnabledAt,
    extendOutboxRequestIDs: v3.extendOutboxRequestIDs,
    createdAt: v3.createdAt,
    updatedAt: v3.updatedAt,
  })
}

export function upgradeOutboxV1ToV2(v1: z.infer<typeof ClarusOutboxRecordV1>): ClarusOutboxRecordV2 {
  let state: ClarusOutboxStateV2
  switch (v1.state) {
    case "pending":
    case "sent":
      state = "prepared"
      break
    case "acknowledged":
      state = "acknowledged"
      break
    case "rejected":
      state = "rejected"
      break
    case "ambiguous":
      state = "ambiguous"
      break
    default:
      state = "prepared"
  }

  const now = Date.now()
  const hasResolution = !!v1.resolvedAt
  return ClarusOutboxRecordV2.parse({
    schemaVersion: 2,
    requestID: v1.requestID,
    action: v1.action,
    agentId: v1.agentId,
    projectId: v1.projectId,
    taskId: v1.taskId,
    payload: v1.payload ?? {},
    payloadHash: v1.payload ? canonicalHash(v1.payload) : "",
    state,
    preparedAt: hasResolution && state !== "prepared" ? (v1.resolvedAt as number) : v1.createdAt,
    ...(hasResolution ? { dispatchedAt: v1.resolvedAt } : {}),
    ...(state === "acknowledged" && hasResolution ? { acknowledgedAt: v1.resolvedAt } : {}),
    ...(state === "rejected" ? { rejectedAt: v1.resolvedAt ?? now, errorCode: "v1_upgrade" } : {}),
    ...(state === "ambiguous" ? { ambiguousAt: v1.resolvedAt ?? now } : {}),
  })
}
