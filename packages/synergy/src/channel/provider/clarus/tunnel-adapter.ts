import z from "zod"
import {
  NATIVE_MAX_ARRAY_LENGTH,
  NATIVE_MAX_FILE_REFS,
  NATIVE_MAX_ID_LENGTH,
  NATIVE_MAX_OBJECT_DEPTH,
  NATIVE_MAX_OBJECT_KEYS,
  NATIVE_MAX_PAYLOAD_BYTES,
  NATIVE_MAX_STRING_LENGTH,
} from "@/holos/native"
import { isRecord } from "@/util/is-record"
import type { NativeMessage, NativeTunnelPort } from "@/holos/native"
import type {
  SubscribeProjectInput,
  UnsubscribeProjectInput,
  AcceptTaskInput,
  ExtendTaskInput,
  RecordTaskResultInput,
  ClarusRequestResult,
  ClarusRequestFailure,
  ProjectSubscribedEvent,
  ProjectUnsubscribedEvent,
  RuntimeTaskAssignedEvent,
  RuntimeTaskAcceptedEvent,
  RuntimeTaskExtendedEvent,
  RuntimeTaskResultRecordedEvent,
  ClarusKnownEvent,
  ClarusObservedEvent,
  ClarusAgentTunnelPort,
} from "./agent-tunnel-port"

const REQUEST_ID_MAX = 128

function validateRequestID(requestID: string): string {
  const trimmed = requestID.trim()
  if (!trimmed || trimmed.length > REQUEST_ID_MAX) {
    throw {
      disposition: "rejected" as const,
      requestID,
      code: "INVALID_REQUEST_ID",
      message: `requestID must be 1-${REQUEST_ID_MAX} chars`,
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

const Identity = z.string().max(NATIVE_MAX_ID_LENGTH)
const NonBlankRunID = Identity.refine((value) => value.trim().length > 0, { message: "run_id must not be blank" })
const Deadline = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "deadline must be a valid date-time",
})

const ProjectSubscribedPayload = z.object({ project_id: Identity, subscribed: z.literal(true) }).passthrough()
const ProjectUnsubscribedPayload = z.object({ project_id: Identity, subscribed: z.literal(false) }).passthrough()
const ProjectMembershipAcceptedPayload = z
  .object({
    project_id: Identity,
    membership: z
      .object({
        member_id: Identity,
        project_id: Identity,
        actor_type: z.literal("agent"),
        actor_id: Identity,
        role: z.enum(["editor", "viewer"]),
        status: z.enum(["pending", "active", "declined"]),
        invited_at: Deadline.nullable(),
        accepted_at: Deadline.nullable(),
        invited_by_user_id: z.number().int().nullable(),
        created_at: Deadline,
      })
      .passthrough(),
  })
  .superRefine((value, context) => {
    if (value.membership.project_id !== value.project_id) {
      context.addIssue({
        code: "custom",
        path: ["membership", "project_id"],
        message: "membership project_id must match project_id",
      })
    }
  })
  .passthrough()

const RuntimeTaskAssignedPayload = z
  .object({
    run_id: NonBlankRunID,
    project_id: Identity,
    task_id: Identity,
    phase: Identity,
    subtask_id: Identity,
    attempt: z.number().int().positive(),
    deadline_at: Deadline.nullable(),
    attempt_mode: Identity.nullable().optional(),
    retry_of_task_id: Identity.nullable().optional(),
  })
  .passthrough()
const RuntimeTaskAcceptedPayload = z
  .object({
    run_id: NonBlankRunID,
    project_id: Identity,
    task_id: Identity,
    subtask_id: Identity,
    attempt: z.number().int().positive(),
    accepted_at: Deadline,
  })
  .passthrough()

const ClarusTaskWire = z
  .object({
    task_id: Identity,
    run_id: NonBlankRunID,
    project_id: Identity,
    phase: Identity,
    subtask_id: Identity,
    attempt: z.number().int().positive(),
    assigned_agent_id: Identity.optional(),
    resolution_id: Identity.optional(),
    attempt_mode: Identity.nullable().optional(),
    retry_of_task_id: Identity.nullable().optional(),
    superseded_at: z.string().nullable().optional(),
    status: z.string(),
    input: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.string().nullable().optional(),
    deadline_at: Deadline.nullable(),
    dispatched_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .passthrough()

const RuntimeTaskExtendedPayload = z
  .object({ project_id: Identity, run_id: NonBlankRunID, task: ClarusTaskWire })
  .passthrough()

const RuntimeTaskResultRecordedPayload = z
  .object({ project_id: Identity, run_id: NonBlankRunID, task: ClarusTaskWire })
  .passthrough()

const knownPayloadSchemas = {
  "clarus.project.subscribed": ProjectSubscribedPayload,
  "clarus.project.unsubscribed": ProjectUnsubscribedPayload,
  "clarus.project.membership.accepted": ProjectMembershipAcceptedPayload,
  "clarus.runtime.task.assigned": RuntimeTaskAssignedPayload,
  "clarus.runtime.task.accepted": RuntimeTaskAcceptedPayload,
  "clarus.runtime.task.extended": RuntimeTaskExtendedPayload,
  "clarus.runtime.task.result.recorded": RuntimeTaskResultRecordedPayload,
} as const

const OUTBOUND_OPERATIONS = {
  subscribeProject: { wireType: "clarus.project.subscribe", responseType: "clarus.project.subscribed" },
  unsubscribeProject: { wireType: "clarus.project.unsubscribe", responseType: "clarus.project.unsubscribed" },
  acceptTask: { wireType: "clarus.runtime.task.accept", responseType: "clarus.runtime.task.accepted" },
  extendTask: { wireType: "clarus.runtime.task.extend", responseType: "clarus.runtime.task.extended" },
  recordTaskResult: { wireType: "clarus.runtime.task.result", responseType: "clarus.runtime.task.result.recorded" },
} as const

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

namespace Bounds {
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
      dto = { ...base, type: "projectSubscribed", projectID: p.project_id }
      break
    }
    case "clarus.project.unsubscribed": {
      const p = parsed.payload as { project_id: string; subscribed: boolean }
      dto = { ...base, type: "projectUnsubscribed", projectID: p.project_id }
      break
    }
    case "clarus.project.membership.accepted": {
      const p = parsed.payload
      dto = { ...base, type: "projectMembershipAccepted", projectID: p.project_id }
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
        projectID: p.project_id,
        runID: p.run_id,
        taskID: p.task_id,
        phase: p.phase,
        subtaskID: p.subtask_id,
        attempt: p.attempt,
        deadlineAt: p.deadline_at,
        attemptMode: p.attempt_mode == null ? undefined : p.attempt_mode,
        retryOfTaskID: p.retry_of_task_id == null ? undefined : p.retry_of_task_id,
        goal,
        instructions,
        input,
        context,
        taskInput,
      }
      break
    }
    case "clarus.runtime.task.accepted": {
      const p = parsed.payload
      dto = {
        ...base,
        type: "runtimeTaskAccepted",
        projectID: p.project_id,
        runID: p.run_id,
        taskID: p.task_id,
        subtaskID: p.subtask_id,
        attempt: p.attempt,
        acceptedAt: p.accepted_at,
      }
      break
    }
    case "clarus.runtime.task.extended": {
      const p = parsed.payload
      dto = {
        ...base,
        type: "runtimeTaskExtended",
        projectID: p.project_id,
        runID: p.run_id,
        task: {
          taskID: p.task.task_id,
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
        projectID: p.project_id,
        runID: p.run_id,
        task: {
          taskID: p.task.task_id,
          subtaskID: p.task.subtask_id,
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

export function createClarusAgentTunnelAdapter(tunnel: NativeTunnelPort): ClarusAgentTunnelPort {
  return {
    registerEventHandler(handler) {
      return tunnel.registerNativeObserver((msg) => {
        if (!msg.type.startsWith("clarus.")) return
        return handler(toSemanticEvent(msg.type, msg.agentID, msg.requestID, msg.epoch, msg.generation, msg.payload))
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
    acceptTask(input: AcceptTaskInput) {
      const rejection = rejectBlankRunID<RuntimeTaskAcceptedEvent>(input)
      if (rejection) return rejection
      return makeRequest(
        tunnel,
        OUTBOUND_OPERATIONS.acceptTask.wireType,
        OUTBOUND_OPERATIONS.acceptTask.responseType,
        {
          run_id: input.runID,
          project_id: input.projectID,
          task_id: input.taskID,
          subtask_id: input.subtaskID,
          attempt: input.attempt,
        },
        input.requestID,
        input.timeoutMs,
        input.signal,
        (msg) => {
          const p = RuntimeTaskAcceptedPayload.parse(msg.payload)
          if (
            p.run_id !== input.runID ||
            p.project_id !== input.projectID ||
            p.task_id !== input.taskID ||
            p.subtask_id !== input.subtaskID ||
            p.attempt !== input.attempt
          ) {
            throw new Error("Task accept response identity mismatch")
          }
          return {
            kind: "known" as const,
            type: "runtimeTaskAccepted" as const,
            agentID: msg.agentID,
            requestID: msg.requestID,
            epoch: msg.epoch,
            generation: msg.generation,
            projectID: p.project_id,
            runID: p.run_id,
            taskID: p.task_id,
            subtaskID: p.subtask_id,
            attempt: p.attempt,
            acceptedAt: p.accepted_at,
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
