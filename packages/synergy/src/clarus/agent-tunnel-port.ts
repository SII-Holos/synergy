// Clarus Agent Tunnel port interface — types and contract that bridge
// the native tunnel transport to Clarus domain semantics.

import type { HolosConnectionEvent } from "../holos/native"

export type ClarusRequestOptions = {
  requestID: string
  timeoutMs?: number
  signal?: AbortSignal
}

export type SubscribeProjectInput = ClarusRequestOptions & { projectID: string }
export type UnsubscribeProjectInput = ClarusRequestOptions & { projectID: string }

export type SendProjectMessageInput = ClarusRequestOptions & {
  projectID: string
  content: string
  messageType?: string
  fileRefs?: Array<Record<string, unknown>>
}

export type ExtendTaskInput = ClarusRequestOptions & {
  runID: string
  taskID?: string | null
  subtaskID?: string | null
  extendSeconds?: number | null
  progress?: string | null
  payload?: Record<string, unknown>
}

export type RecordTaskResultInput = ClarusRequestOptions & {
  runID: string
  taskID?: string | null
  subtaskID: string
  success: boolean
  output: string
  artifacts: Array<Record<string, unknown>>
  evidenceRefs: string[]
  notaryRefs: string[]
  error?: string | null
  payload: Record<string, unknown>
}

export type ClarusRequestResult<T> = { requestID: string; response: Promise<T> }

export type ClarusRequestFailure =
  | { disposition: "rejected"; requestID: string; code: string; message: string }
  | {
      disposition: "ambiguous"
      requestID: string
      reason: "timeout" | "aborted_after_dispatch" | "disconnected" | "invalid_response" | "unexpected_response"
      message: string
    }

export type ProjectSubscribedEvent = {
  kind: "known"
  type: "projectSubscribed"
  agentID: string
  requestID: string | null
  projectID: string
  epoch: number
  generation: number
}
export type ProjectUnsubscribedEvent = {
  kind: "known"
  type: "projectUnsubscribed"
  agentID: string
  requestID: string | null
  projectID: string
  epoch: number
  generation: number
}
export type ProjectMessageCreatedEvent = {
  kind: "known"
  type: "projectMessageCreated"
  agentID: string
  requestID: string | null
  projectID: string
  message: { messageID: string; senderID: string; content: string }
  epoch: number
  generation: number
}
export type RuntimeTaskAssignedEvent = {
  kind: "known"
  type: "runtimeTaskAssigned"
  agentID: string
  requestID: string | null
  projectID: string
  runID: string
  taskID: string
  phase: string
  subtaskID: string
  attempt: number
  deadlineAt: string | null
  goal?: string | null
  instructions?: string | null
  input?: Record<string, unknown> | null
  context?: Record<string, unknown> | null
  taskInput?: Record<string, unknown> | null
  epoch: number
  generation: number
}
export type RuntimeTaskExtendedEvent = {
  kind: "known"
  type: "runtimeTaskExtended"
  agentID: string
  requestID: string | null
  projectID: string
  runID: string
  task: { taskID: string; deadlineAt: string | null; status: string }
  epoch: number
  generation: number
}
export type RuntimeTaskResultRecordedEvent = {
  kind: "known"
  type: "runtimeTaskResultRecorded"
  agentID: string
  requestID: string | null
  projectID: string
  runID: string
  task: { taskID: string; subtaskID: string; status: string }
  epoch: number
  generation: number
}
export type ProjectFileUploadedEvent = {
  kind: "known"
  type: "projectFileUploaded"
  agentID: string
  requestID: string | null
  projectID: string
  epoch: number
  generation: number
}
export type ProjectSystemEvent = {
  kind: "known"
  type: "projectSystemEvent"
  agentID: string
  requestID: string | null
  projectID: string
  eventType: string
  epoch: number
  generation: number
}
export type NotaryRecordCreatedEvent = {
  kind: "known"
  type: "notaryRecordCreated"
  agentID: string
  requestID: string | null
  projectID: string
  epoch: number
  generation: number
}
export type ClarusKnownEvent =
  | ProjectSubscribedEvent
  | ProjectUnsubscribedEvent
  | ProjectMessageCreatedEvent
  | RuntimeTaskAssignedEvent
  | RuntimeTaskExtendedEvent
  | RuntimeTaskResultRecordedEvent
  | ProjectFileUploadedEvent
  | ProjectSystemEvent
  | NotaryRecordCreatedEvent

export type ClarusUnknownEvent = {
  kind: "unknown"
  sourceType: string
  agentID: string
  requestID: string | null
  epoch: number
  generation: number
}
export type ClarusInvalidEvent = {
  kind: "invalid"
  sourceType: string
  agentID: string
  requestID: string | null
  issues: readonly { path: PropertyKey[]; message: string }[]
  epoch: number
  generation: number
}

export type ClarusObservedEvent = ClarusKnownEvent | ClarusUnknownEvent | ClarusInvalidEvent
export type ClarusEventHandler = (event: ClarusObservedEvent) => void | Promise<void>
export type HolosConnectionHandler = (event: HolosConnectionEvent) => void | Promise<void>

export interface ClarusAgentTunnelPort {
  registerEventHandler(handler: ClarusEventHandler): () => void
  registerConnectionHandler(handler: HolosConnectionHandler): () => void
  subscribeProject(input: SubscribeProjectInput): ClarusRequestResult<ProjectSubscribedEvent>
  unsubscribeProject(input: UnsubscribeProjectInput): ClarusRequestResult<ProjectUnsubscribedEvent>
  sendProjectMessage(input: SendProjectMessageInput): ClarusRequestResult<ProjectMessageCreatedEvent>
  extendTask(input: ExtendTaskInput): ClarusRequestResult<RuntimeTaskExtendedEvent>
  recordTaskResult(input: RecordTaskResultInput): ClarusRequestResult<RuntimeTaskResultRecordedEvent>
}
