import z from "zod"
import {
  NATIVE_MAX_ARRAY_LENGTH,
  NATIVE_MAX_FILE_REFS,
  NATIVE_MAX_ID_LENGTH,
  NATIVE_MAX_OBJECT_DEPTH,
  NATIVE_MAX_OBJECT_KEYS,
  NATIVE_MAX_PAYLOAD_BYTES,
  NATIVE_MAX_STRING_LENGTH,
} from "./native"
import { isRecord } from "../util/is-record"
import type { NativeMessage, NativeTunnelPort } from "./native"
import type {
  SubscribeProjectInput,
  UnsubscribeProjectInput,
  SendProjectMessageInput,
  ExtendTaskInput,
  RecordTaskResultInput,
  ClarusRequestResult,
  ClarusRequestFailure,
  ProjectSubscribedEvent,
  ProjectUnsubscribedEvent,
  ProjectMessageCreatedEvent,
  RuntimeTaskAssignedEvent,
  RuntimeTaskExtendedEvent,
  RuntimeTaskResultRecordedEvent,
  ClarusKnownEvent,
  ClarusObservedEvent,
  ClarusAgentTunnelPort,
} from "../clarus/agent-tunnel-port"

// ── Request ID validation ───────────────────────────────────────────

const REQUEST_ID_MAX = 128

function validateRequestID(requestID: string): string {
  const trimmed = requestID.trim()
  if (!trimmed || trimmed.length > REQUEST_ID_MAX) {
    throw {
      disposition: "rejected" as const,
      requestID,
      code: "INVALID_REQUEST_ID",
      message: `requestID must be 1–${REQUEST_ID_MAX} chars`,
    }
  }
  if (trimmed !== requestID) {
    throw {
      disposition: "rejected" as const,
      requestID,
      code: "INVALID_REQUEST_ID",
      message: "requestID must not have leading or trailing whitespace",
    }
  }
  return requestID
}

// ── Wire payload schemas ────────────────────────────────────────────

const NonBlankRunID = z.string().refine((value) => value.trim().length > 0, { message: "run_id must not be blank" })

const ProjectSubscribedPayload = z.object({ project_id: z.string(), subscribed: z.literal(true) }).passthrough()
const ProjectUnsubscribedPayload = z.object({ project_id: z.string(), subscribed: z.literal(false) }).passthrough()

const ClarusMessageWire = z
  .object({
    message_id: z.string(),
    project_id: z.string(),
    channel_id: z.string(),
    sender_type: z.string(),
    sender_id: z.string(),
    sender_name: z.string().nullable().optional(),
    message_type: z.string(),
    content: z.string(),
    file_refs: z.unknown(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.string().nullable(),
  })
  .passthrough()

const ProjectMessageCreatedPayload = z.object({ project_id: z.string(), message: ClarusMessageWire }).passthrough()
const ProjectFileUploadedPayload = z.object({ project_id: z.string() }).passthrough()
const ProjectSystemEventPayload = z.object({ project_id: z.string(), event_type: z.string() }).passthrough()
const NotaryRecordCreatedPayload = z.object({ project_id: z.string() }).passthrough()

const RuntimeTaskAssignedPayload = z
  .object({
    run_id: NonBlankRunID,
    project_id: z.string(),
    task_id: z.string(),
    phase: z.string(),
    subtask_id: z.string(),
    attempt: z.number(),
    deadline_at: z.string().nullable(),
  })
  .passthrough()

const ClarusTaskWire = z
  .object({
    task_id: z.string(),
    run_id: NonBlankRunID,
    project_id: z.string(),
    phase: z.string(),
    subtask_id: z.string(),
    attempt: z.number(),
    assigned_agent_id: z.string().optional(),
    resolution_id: z.string().optional(),
    attempt_mode: z.string().optional(),
    retry_of_task_id: z.string().optional(),
    superseded_at: z.string().nullable().optional(),
    status: z.string(),
    input: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.string().nullable().optional(),
    deadline_at: z.string().nullable(),
    dispatched_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .passthrough()

const RuntimeTaskExtendedPayload = z
  .object({ project_id: z.string(), run_id: NonBlankRunID, task: ClarusTaskWire })
  .passthrough()

const RuntimeTaskResultRecordedPayload = z
  .object({ project_id: z.string(), run_id: NonBlankRunID, task: ClarusTaskWire })
  .passthrough()

const knownPayloadSchemas = {
  "clarus.project.subscribed": ProjectSubscribedPayload,
  "clarus.project.unsubscribed": ProjectUnsubscribedPayload,
  "clarus.project.message.created": ProjectMessageCreatedPayload,
  "clarus.project.file.uploaded": ProjectFileUploadedPayload,
  "clarus.project.system.event": ProjectSystemEventPayload,
  "clarus.notary.record.created": NotaryRecordCreatedPayload,
  "clarus.runtime.task.assigned": RuntimeTaskAssignedPayload,
  "clarus.runtime.task.extended": RuntimeTaskExtendedPayload,
  "clarus.runtime.task.result.recorded": RuntimeTaskResultRecordedPayload,
} as const

const OUTBOUND_OPERATIONS = {
  subscribeProject: { wireType: "clarus.project.subscribe", responseType: "clarus.project.subscribed" },
  unsubscribeProject: { wireType: "clarus.project.unsubscribe", responseType: "clarus.project.unsubscribed" },
  sendProjectMessage: { wireType: "clarus.project.message.send", responseType: "clarus.project.message.created" },
  extendTask: { wireType: "clarus.runtime.task.extend", responseType: "clarus.runtime.task.extended" },
  recordTaskResult: { wireType: "clarus.runtime.task.result", responseType: "clarus.runtime.task.result.recorded" },
} as const

// ── Payload parsing ─────────────────────────────────────────────────

export namespace ClarusPayload {
  export type Known = {
    [T in keyof typeof knownPayloadSchemas]: {
      kind: "known"
      type: T
      payload: z.infer<(typeof knownPayloadSchemas)[T]>
    }
  }[keyof typeof knownPayloadSchemas]
  export type Parsed = Known | { kind: "unknown" } | { kind: "invalid"; type: string; issues: readonly z.ZodIssue[] }

  export function parseKnown(type: string, payload: unknown): Parsed {
    if (!(type in knownPayloadSchemas)) return { kind: "unknown" }
    const schema = knownPayloadSchemas[type as keyof typeof knownPayloadSchemas]
    const result = schema.safeParse(payload)
    if (result.success) return { kind: "known", type, payload: result.data } as Known
    return { kind: "invalid", type, issues: result.error.issues }
  }
}

// ── Native semantic field bounding ───────────────────────────────────

namespace Bounds {
  export function id(value: string): string {
    return value.length > NATIVE_MAX_ID_LENGTH ? value.slice(0, NATIVE_MAX_ID_LENGTH) : value
  }

  export function string(value: string): string {
    return value.length > NATIVE_MAX_STRING_LENGTH ? value.slice(0, NATIVE_MAX_STRING_LENGTH) : value
  }

  export function object(
    value: Record<string, unknown>,
    depth = NATIVE_MAX_OBJECT_DEPTH,
    visited: WeakSet<object> = new WeakSet(),
  ): Record<string, unknown> | null {
    if (depth <= 0) return null
    if (visited.has(value)) return null
    visited.add(value)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).slice(0, NATIVE_MAX_OBJECT_KEYS)) {
      const v = value[key]
      if (v == null || typeof v !== "object") {
        result[key] = v
      } else if (Array.isArray(v)) {
        if (visited.has(v)) continue
        visited.add(v)
        result[key] = v
          .slice(0, NATIVE_MAX_ARRAY_LENGTH)
          .map((item) => (isRecord(item) ? object(item as Record<string, unknown>, depth - 1, visited) : item))
      } else if (isRecord(v)) {
        const bounded = object(v, depth - 1, visited)
        if (bounded !== null) result[key] = bounded
      } else {
        result[key] = v
      }
    }
    return result
  }

  export function fileRefs(refs: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(refs)) return []
    return refs.slice(0, NATIVE_MAX_FILE_REFS).reduce<Array<Record<string, unknown>>>((acc, r) => {
      const bounded = isRecord(r) ? object(r) : null
      if (bounded) acc.push(bounded)
      return acc
    }, [])
  }
}

// ── DTO conversion ──────────────────────────────────────────────────

type SemanticEventBase = {
  kind: "known"
  agentID: string
  requestID: string | null
  epoch: number
  generation: number
}

function toSemanticDTO(
  parsed: ClarusPayload.Known,
  agentID: string,
  requestID: string | null,
  epoch: number,
  generation: number,
): ClarusKnownEvent | null {
  const base: SemanticEventBase = { kind: "known", agentID, requestID, epoch, generation }
  let dto: ClarusKnownEvent | null = null
  switch (parsed.type) {
    case "clarus.project.subscribed": {
      const p = parsed.payload
      dto = { ...base, type: "projectSubscribed", projectID: Bounds.id(p.project_id) }
      break
    }
    case "clarus.project.unsubscribed": {
      const p = parsed.payload as { project_id: string; subscribed: boolean }
      dto = { ...base, type: "projectUnsubscribed", projectID: Bounds.id(p.project_id) }
      break
    }
    case "clarus.project.message.created": {
      const p = parsed.payload
      dto = {
        ...base,
        type: "projectMessageCreated",
        projectID: Bounds.id(p.project_id),
        message: {
          messageID: Bounds.id(p.message.message_id),
          senderID: Bounds.id(p.message.sender_id),
          content: Bounds.string(p.message.content),
        },
      }
      break
    }
    case "clarus.project.file.uploaded": {
      const p = parsed.payload
      dto = { ...base, type: "projectFileUploaded", projectID: Bounds.id(p.project_id) }
      break
    }
    case "clarus.project.system.event": {
      const p = parsed.payload
      dto = {
        ...base,
        type: "projectSystemEvent",
        projectID: Bounds.id(p.project_id),
        eventType: Bounds.id(p.event_type),
      }
      break
    }
    case "clarus.notary.record.created": {
      const p = parsed.payload
      dto = { ...base, type: "notaryRecordCreated", projectID: Bounds.id(p.project_id) }
      break
    }
    case "clarus.runtime.task.assigned": {
      const p = parsed.payload
      const extra = p as Record<string, unknown>
      const goal = typeof extra.goal === "string" ? Bounds.string(extra.goal) : null
      const instructions = typeof extra.instructions === "string" ? Bounds.string(extra.instructions) : null
      const input = isRecord(extra.input) ? Bounds.object(extra.input) : null
      const context = isRecord(extra.context) ? Bounds.object(extra.context) : null
      const taskInput = isRecord(extra.task_input) ? Bounds.object(extra.task_input) : null
      dto = {
        ...base,
        type: "runtimeTaskAssigned",
        projectID: Bounds.id(p.project_id),
        runID: Bounds.id(p.run_id),
        taskID: Bounds.id(p.task_id),
        phase: Bounds.id(p.phase),
        subtaskID: Bounds.id(p.subtask_id),
        attempt: p.attempt,
        deadlineAt: p.deadline_at,
        goal,
        instructions,
        input,
        context,
        taskInput,
      }
      break
    }
    case "clarus.runtime.task.extended": {
      const p = parsed.payload
      dto = {
        ...base,
        type: "runtimeTaskExtended",
        projectID: Bounds.id(p.project_id),
        runID: Bounds.id(p.run_id),
        task: {
          taskID: Bounds.id(p.task.task_id),
          deadlineAt: p.task.deadline_at,
          status: Bounds.string(p.task.status),
        },
      }
      break
    }
    case "clarus.runtime.task.result.recorded": {
      const p = parsed.payload
      dto = {
        ...base,
        type: "runtimeTaskResultRecorded",
        projectID: Bounds.id(p.project_id),
        runID: Bounds.id(p.run_id),
        task: {
          taskID: Bounds.id(p.task.task_id),
          subtaskID: Bounds.id(p.task.subtask_id),
          status: Bounds.string(p.task.status),
        },
      }
      break
    }
    default:
      return null
  }
  if (dto == null) return null
  if (new TextEncoder().encode(JSON.stringify(dto)).length > NATIVE_MAX_PAYLOAD_BYTES) return null
  return dto
}

function toSemanticEvent(
  wireType: string,
  agentID: string,
  requestID: string | null,
  epoch: number,
  generation: number,
  payload: unknown,
): ClarusObservedEvent {
  if (!wireType.startsWith("clarus."))
    return { kind: "unknown", sourceType: wireType, agentID, requestID, epoch, generation }
  const parsed = ClarusPayload.parseKnown(wireType, payload)
  switch (parsed.kind) {
    case "known": {
      const dto = toSemanticDTO(parsed, agentID, requestID, epoch, generation)
      if (dto) return dto
      return { kind: "unknown", sourceType: wireType, agentID, requestID, epoch, generation }
    }
    case "unknown":
      return { kind: "unknown", sourceType: wireType, agentID, requestID, epoch, generation }
    case "invalid":
      return {
        kind: "invalid",
        sourceType: wireType,
        agentID,
        requestID,
        epoch,
        generation,
        issues: parsed.issues.map((i) => ({ path: i.path as PropertyKey[], message: i.message })),
      }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function rejectBlankRunID<T>(input: { runID: string; requestID: string }): ClarusRequestResult<T> | null {
  if (input.runID.trim()) return null
  return {
    requestID: input.requestID,
    response: Promise.reject({
      disposition: "rejected" as const,
      requestID: input.requestID,
      code: "INVALID_RUN_ID",
      message: "runID must not be blank",
    }),
  }
}

function buildOutboundMeta(): Record<string, unknown> {
  return { schema_version: "1.0" }
}

function safeMap<T>(requestID: string, fn: (msg: NativeMessage) => T): (msg: NativeMessage) => T {
  return (msg: NativeMessage) => {
    try {
      return fn(msg)
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issues = err.issues.map((i) => Bounds.string(i.message)).join(", ")
        throw {
          disposition: "ambiguous" as const,
          requestID,
          reason: "invalid_response" as const,
          message: `Response validation failed: ${issues}`,
        }
      }
      if (err && typeof err === "object" && "disposition" in err) throw err
      throw {
        disposition: "ambiguous" as const,
        requestID,
        reason: "invalid_response" as const,
        message: `Response validation failed`,
      }
    }
  }
}

// ── Request helper ─────────────────────────────────────────────────

function makeRequest<T>(
  tunnel: NativeTunnelPort,
  wireType: string,
  responseType: string,
  wirePayload: unknown,
  requestID: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  mapResponse: (msg: NativeMessage) => T,
): ClarusRequestResult<T> {
  let id: string
  try {
    id = validateRequestID(requestID)
  } catch (rejection) {
    return { requestID, response: Promise.reject(rejection) }
  }
  try {
    const { requestID: returnedID, response } = tunnel.sendNativeRequest({
      type: wireType,
      payload: wirePayload,
      requestID: id,
      expectedResponseType: responseType,
      timeoutMs,
      signal,
      meta: buildOutboundMeta(),
    })
    return { requestID: returnedID, response: response.then(safeMap(returnedID, mapResponse)) }
  } catch (rejection) {
    return { requestID: id, response: Promise.reject(rejection) }
  }
}

// ── Adapter factory ─────────────────────────────────────────────────

export function createClarusAgentTunnelAdapter(tunnel: NativeTunnelPort): ClarusAgentTunnelPort {
  return {
    registerEventHandler(handler) {
      return tunnel.registerNativeObserver((msg) => {
        if (!msg.type.startsWith("clarus.")) return
        const result = handler(
          toSemanticEvent(msg.type, msg.agentID, msg.requestID, msg.epoch, msg.generation, msg.payload),
        )
        if (result instanceof Promise) result.catch(() => {})
      })
    },
    registerConnectionHandler(handler) {
      return tunnel.registerConnectionObserver(handler)
    },

    subscribeProject(input: SubscribeProjectInput) {
      return makeRequest(
        tunnel,
        OUTBOUND_OPERATIONS.subscribeProject.wireType,
        OUTBOUND_OPERATIONS.subscribeProject.responseType,
        { project_id: input.projectID },
        input.requestID,
        input.timeoutMs,
        input.signal,
        (msg) => {
          const p = ProjectSubscribedPayload.parse(msg.payload)
          return {
            kind: "known" as const,
            type: "projectSubscribed" as const,
            agentID: msg.agentID,
            requestID: msg.requestID,
            epoch: msg.epoch,
            generation: msg.generation,
            projectID: p.project_id,
          }
        },
      )
    },
    unsubscribeProject(input: UnsubscribeProjectInput) {
      return makeRequest(
        tunnel,
        OUTBOUND_OPERATIONS.unsubscribeProject.wireType,
        OUTBOUND_OPERATIONS.unsubscribeProject.responseType,
        { project_id: input.projectID },
        input.requestID,
        input.timeoutMs,
        input.signal,
        (msg) => {
          const p = ProjectUnsubscribedPayload.parse(msg.payload)
          return {
            kind: "known" as const,
            type: "projectUnsubscribed" as const,
            agentID: msg.agentID,
            requestID: msg.requestID,
            epoch: msg.epoch,
            generation: msg.generation,
            projectID: p.project_id,
          }
        },
      )
    },
    sendProjectMessage(input: SendProjectMessageInput) {
      const payload: Record<string, unknown> = { project_id: input.projectID, content: input.content }
      if (input.messageType != null) payload.message_type = input.messageType
      if (input.fileRefs != null) payload.file_refs = input.fileRefs
      return makeRequest(
        tunnel,
        OUTBOUND_OPERATIONS.sendProjectMessage.wireType,
        OUTBOUND_OPERATIONS.sendProjectMessage.responseType,
        payload,
        input.requestID,
        input.timeoutMs,
        input.signal,
        (msg) => {
          const p = ProjectMessageCreatedPayload.parse(msg.payload)
          return {
            kind: "known" as const,
            type: "projectMessageCreated" as const,
            agentID: msg.agentID,
            requestID: msg.requestID,
            epoch: msg.epoch,
            generation: msg.generation,
            projectID: p.project_id,
            message: { messageID: p.message.message_id, senderID: p.message.sender_id, content: p.message.content },
          }
        },
      )
    },
    extendTask(input: ExtendTaskInput) {
      const rejection = rejectBlankRunID<RuntimeTaskExtendedEvent>(input)
      if (rejection) return rejection
      const payload: Record<string, unknown> = { run_id: input.runID }
      if (input.taskID != null) payload.task_id = input.taskID
      if (input.subtaskID != null) payload.subtask_id = input.subtaskID
      if (input.extendSeconds != null) payload.extend_seconds = input.extendSeconds
      if (input.progress != null) payload.progress = input.progress
      if (input.payload != null) payload.payload = input.payload
      return makeRequest(
        tunnel,
        OUTBOUND_OPERATIONS.extendTask.wireType,
        OUTBOUND_OPERATIONS.extendTask.responseType,
        payload,
        input.requestID,
        input.timeoutMs,
        input.signal,
        (msg) => {
          const p = RuntimeTaskExtendedPayload.parse(msg.payload)
          return {
            kind: "known" as const,
            type: "runtimeTaskExtended" as const,
            agentID: msg.agentID,
            requestID: msg.requestID,
            epoch: msg.epoch,
            generation: msg.generation,
            projectID: p.project_id,
            runID: p.run_id,
            task: { taskID: p.task.task_id, deadlineAt: p.task.deadline_at, status: p.task.status },
          }
        },
      )
    },
    recordTaskResult(input: RecordTaskResultInput) {
      const rejection = rejectBlankRunID<RuntimeTaskResultRecordedEvent>(input)
      if (rejection) return rejection
      const payload: Record<string, unknown> = {
        run_id: input.runID,
        subtask_id: input.subtaskID,
        success: input.success,
        output: input.output,
        artifacts: input.artifacts,
        evidence_refs: input.evidenceRefs,
        notary_refs: input.notaryRefs,
        payload: input.payload,
      }
      if (input.taskID != null) payload.task_id = input.taskID
      if (input.error != null) payload.error = input.error
      return makeRequest(
        tunnel,
        OUTBOUND_OPERATIONS.recordTaskResult.wireType,
        OUTBOUND_OPERATIONS.recordTaskResult.responseType,
        payload,
        input.requestID,
        input.timeoutMs,
        input.signal,
        (msg) => {
          const p = RuntimeTaskResultRecordedPayload.parse(msg.payload)
          return {
            kind: "known" as const,
            type: "runtimeTaskResultRecorded" as const,
            agentID: msg.agentID,
            requestID: msg.requestID,
            epoch: msg.epoch,
            generation: msg.generation,
            projectID: p.project_id,
            runID: p.run_id,
            task: { taskID: p.task.task_id, subtaskID: p.task.subtask_id, status: p.task.status },
          }
        },
      )
    },
  }
}
