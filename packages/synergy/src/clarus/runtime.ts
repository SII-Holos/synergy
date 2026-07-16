import type { HolosRuntime as HolosRuntimeType } from "@/holos/runtime"
import { HolosRuntime } from "@/holos/runtime"
import { createClarusAgentTunnelAdapter } from "@/holos/clarus"
import { Bus } from "@/bus"
import { Lock } from "@/util/lock"
import { GlobalBus } from "@/bus/global"
import { SessionEvent } from "@/session/event"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { canonicalJSON, canonicalEqual } from "@/util/canonical"
import { Log } from "@/util/log"
import { isRecord } from "@/util/is-record"
import { ClarusWorkspace } from "./workspace"
import { ClarusBindingStore, ClarusTaskBindingStore, isStatusTerminal } from "./binding"
import { ClarusConfigReader } from "./config-reader"
import { ClarusAgentResolver } from "./agent-resolver"
import { ClarusOutbox, isTerminalOutboxState, validateOutboxIdentity } from "./outbox"
import { ClarusProjectActivityStore } from "./activity"
import { bindingKey, payloadHash } from "./keys"
import { deliverProjectMessage, deliverTaskMessage, getOrCreateTaskSession } from "./session-router"
import { NavigationUpdated } from "./event"

import type {
  ClarusAgentTunnelPort,
  ClarusInvalidEvent,
  ClarusObservedEvent,
  ClarusRequestFailure,
  ProjectMessageCreatedEvent,
  ProjectSubscribedEvent,
  ProjectSystemEvent,
  ProjectUnsubscribedEvent,
  RuntimeTaskAssignedEvent,
  RuntimeTaskExtendedEvent,
  RuntimeTaskResultRecordedEvent,
  RecordTaskResultInput,
} from "./agent-tunnel-port"
import type { HolosConnectionEvent } from "@/holos/native"
import { MAX_WIRE_STRING_USER_QUERY, MAX_USER_CANDIDATES } from "./rest-port"
import type { ClarusRestPort } from "./rest-port"
import type {
  ClarusOutboxAction,
  ClarusProjectBindingV3,
  ClarusProjectLifecycle,
  ClarusReconciliationState,
  ClarusTaskContextHydration,
} from "./schemas"
import { ClarusProjectMessagePayloadSchema } from "./schemas"

const log = Log.create({ service: "clarus.runtime" })
const DISCOVERY_INTERVAL_MS = 60_000
const MAX_BUFFERED_EVENTS = 512
const MAX_BUFFERED_EVENT_BYTES = 512 * 1024
const MAX_DISCOVERY_PAGES = 20
const MAX_DISCOVERY_BINDINGS_READ = 500
const BACKFILL_PAGE_BUDGET_PER_CYCLE = 200
const MAX_RECONCILIATION_TIME_MS = 300_000
const MAX_NON_PROGRESSING_PAGES = 3
const MAX_SESSION_BINDING_CACHE = 1000
const MAX_ROTATION_INDEX = 1_000_000

type AttachedTransport = {
  port: ClarusAgentTunnelPort
  eventUnregister: () => void
  connectionUnregister: () => void
  epoch: number
}

type ActiveReconciliation = {
  agentId: string
  epoch: number
  generation: number
  bufferedEvents: ClarusObservedEvent[]
  bufferedBytes: number
  overflowed: boolean
  abortController: AbortController
  startedAt: number
}

/** API-safe status contract for /global/clarus/status. */
export type ClarusRuntimeStatus = {
  agentId: string | null
  status: "disabled" | "disconnected" | "connecting" | "connected" | "reconnecting" | "blocked"
  epoch: number
  generation: number
  isReconciling: boolean
  error?: string
}

/** API-safe result for sendProjectMessage. */
export type SendProjectMessageResult = {
  requestID: string
  messageId: string
  projectId: string
  senderId: string
  userId?: string
  epoch: number
  generation: number
}

type Scheduler = {
  schedule(delayMs: number, callback: () => void): Disposable
}

class ProductionScheduler implements Scheduler {
  schedule(delayMs: number, callback: () => void): Disposable {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return { [Symbol.dispose]: () => clearTimeout(timer) }
  }
}

let attached: AttachedTransport | null = null
let restPort: ClarusRestPort.Interface | null = null
let scheduler: Scheduler = new ProductionScheduler()
let attachmentEpoch = 0
let activeReconciliation: ActiveReconciliation | null = null
let periodicTimer: Disposable | null = null
let periodicReconciliationActive = false
let connectedAgentId: string | null = null
let connectedEpoch = 0
let connectedGeneration = 0
let globalBusHandler: ((event: { directory?: string; payload: unknown }) => void) | null = null
const sessionBindings = new Map<string, { agentId: string; projectId: string; taskId: string }>()
const deadlineTimers = new Map<string, Disposable>()
const sendInFlight = new Map<
  string,
  {
    promise: Promise<SendProjectMessageResult>
    agentId: string
    projectId: string
    userId?: string
    payloadHash: string
    payload: Record<string, unknown>
  }
>()
let initPromise: Promise<void> | null = null
let holosStatusUnsubscribe: (() => void) | null = null
let holosTransportStatus: HolosRuntimeType.Status = { status: "disconnected" }
let wasConnected = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Clarus request failure"
}

function requestFailure(error: unknown): ClarusRequestFailure | undefined {
  if (!isRecord(error)) return undefined
  const disposition = error.disposition
  const requestID = error.requestID
  const message = error.message
  if (
    (disposition !== "rejected" && disposition !== "ambiguous") ||
    typeof requestID !== "string" ||
    typeof message !== "string"
  ) {
    return undefined
  }
  if (disposition === "rejected" && typeof error.code === "string") {
    return {
      disposition,
      requestID,
      code: error.code,
      message,
    }
  }
  if (
    disposition === "ambiguous" &&
    (error.reason === "timeout" ||
      error.reason === "aborted_after_dispatch" ||
      error.reason === "disconnected" ||
      error.reason === "invalid_response" ||
      error.reason === "unexpected_response")
  ) {
    return {
      disposition,
      requestID,
      reason: error.reason,
      message,
    }
  }
  return undefined
}

function isActiveLifecycle(lifecycle: ClarusProjectLifecycle): boolean {
  return lifecycle === "active"
}

function isRunAbortedOrStale(run: ActiveReconciliation): boolean {
  return (
    run.abortController.signal.aborted ||
    !isCurrentReconciliation(run) ||
    Date.now() - run.startedAt > MAX_RECONCILIATION_TIME_MS
  )
}

function isCurrentReconciliation(run: Pick<ActiveReconciliation, "agentId" | "epoch" | "generation">): boolean {
  return (
    activeReconciliation?.agentId === run.agentId &&
    activeReconciliation.epoch === run.epoch &&
    activeReconciliation.generation === run.generation
  )
}

function hasConnectionIdentity(event: ClarusObservedEvent): event is ClarusObservedEvent & {
  epoch: number
  generation: number
} {
  return (
    "epoch" in event && typeof event.epoch === "number" && "generation" in event && typeof event.generation === "number"
  )
}

function isCurrentObservedEvent(event: ClarusObservedEvent): boolean {
  if (!hasConnectionIdentity(event)) return true
  return (
    connectedAgentId === event.agentID && connectedEpoch === event.epoch && connectedGeneration === event.generation
  )
}

function deadlineKey(agentId: string, projectId: string, taskId: string): string {
  return `${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`
}

function unsubscribeSessionEvents(): void {
  if (!globalBusHandler) return
  GlobalBus.off("event", globalBusHandler)
  globalBusHandler = null
}

function subscribeSessionEvents(): void {
  unsubscribeSessionEvents()
  const handler = (event: { directory?: string; payload: unknown }) => {
    if (!isRecord(event.payload)) return
    const type = event.payload.type
    const properties = event.payload.properties
    if (!isRecord(properties) || typeof properties.sessionID !== "string") return
    if (type === SessionEvent.Idle.type) {
      void dispatchResultForSession(properties.sessionID, false)
    } else if (type === SessionEvent.Error.type) {
      void dispatchResultForSession(properties.sessionID, true)
    }
  }
  globalBusHandler = handler
  GlobalBus.on("event", handler)
}

function cancelDeadlineGuard(agentId: string, projectId: string, taskId: string): void {
  const key = deadlineKey(agentId, projectId, taskId)
  const timer = deadlineTimers.get(key)
  if (!timer) return
  timer[Symbol.dispose]()
  deadlineTimers.delete(key)
}

function cancelAllDeadlineGuards(): void {
  for (const timer of deadlineTimers.values()) timer[Symbol.dispose]()
  deadlineTimers.clear()
}

function scheduleDeadlineGuard(input: {
  agentId: string
  projectId: string
  taskId: string
  runID: string
  deadlineAt: string
}): void {
  const key = deadlineKey(input.agentId, input.projectId, input.taskId)
  cancelDeadlineGuard(input.agentId, input.projectId, input.taskId)
  const deadline = Date.parse(input.deadlineAt)
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return
  const delayMs = Math.max(500, deadline - Date.now() - 5_000)
  let timer: Disposable
  timer = scheduler.schedule(delayMs, () => {
    void extendBeforeDeadline(input, timer)
  })
  deadlineTimers.set(key, timer)
}

async function extendBeforeDeadline(
  input: { agentId: string; projectId: string; taskId: string; runID: string; deadlineAt: string },
  timer: Disposable,
): Promise<void> {
  const key = deadlineKey(input.agentId, input.projectId, input.taskId)
  if (deadlineTimers.get(key) !== timer) return
  deadlineTimers.delete(key)
  const transport = attached
  if (!transport) return
  const binding = await ClarusTaskBindingStore.get(input.agentId, input.projectId, input.taskId)
  if (!binding || binding.status !== "running" || binding.runID !== input.runID) return

  const requestID = crypto.randomUUID()
  await ClarusOutbox.preallocate({
    requestID,
    action: "task_extend",
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
    runId: input.runID,
    payload: { run_id: input.runID, task_id: input.taskId },
  })
  let request: ReturnType<ClarusAgentTunnelPort["extendTask"]>
  try {
    request = transport.port.extendTask({ requestID, runID: input.runID, taskID: input.taskId })
    if (request.requestID !== requestID) {
      await ClarusOutbox.markAmbiguous(requestID, "adapter returned a different request ID")
      return
    }
    await ClarusOutbox.markDispatched(requestID)
    await ClarusTaskBindingStore.updateExtensionOutbox(input.agentId, input.projectId, input.taskId, requestID)
  } catch (error) {
    await settleOutboxFailure(requestID, error)
    return
  }

  try {
    const response = await request.response
    if (response.requestID !== requestID) {
      await ClarusOutbox.markAmbiguous(requestID, "extension response request ID did not match")
      return
    }
    await ClarusOutbox.markAcknowledged(requestID)
    await ClarusTaskBindingStore.updateExtension(input.agentId, input.projectId, input.taskId, response.task.deadlineAt)
    if (response.task.deadlineAt) {
      scheduleDeadlineGuard({ ...input, deadlineAt: response.task.deadlineAt })
    }
  } catch (error) {
    await settleOutboxFailure(requestID, error)
  }
}

const SANITIZE_ERROR_MAX_LENGTH = 512

function sanitizeErrorText(text: string): string {
  let sanitized = text
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SANITIZE_ERROR_MAX_LENGTH)
  sanitized = sanitized.replace(/https?:\/\/[^\s"'<>`]+/gi, "[URL redacted]")
  sanitized = sanitized.replace(/wss?:\/\/[^\s"'<>`]+/gi, "[URL redacted]")
  sanitized = sanitized.replace(/\bBearer\s+\S+/gi, "Bearer [token redacted]")
  sanitized = sanitized.replace(/~\/[^\s"'<>`]+/g, "[path redacted]")
  sanitized = sanitized.replace(/(?<!\w)\/[\w.-]+(?:\/[\w.-]+)+/g, "[path redacted]")
  sanitized = sanitized.replace(/[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+/g, "[path redacted]")
  sanitized = sanitized.replace(/\/\/[\w.-]+(?:\/[\w.-]+)*/g, "[path redacted]")
  sanitized = sanitized.replace(/\\\\[\w.-]+(?:\\[\w.-]+)*/g, "[path redacted]")
  return sanitized
}

async function settleOutboxFailure(requestID: string, error: unknown): Promise<void> {
  const failure = requestFailure(error)
  if (failure?.disposition === "rejected") {
    await ClarusOutbox.markRejected(requestID, failure.code, sanitizeErrorText(failure.message))
    return
  }
  await ClarusOutbox.markAmbiguous(requestID, undefined, sanitizeErrorText(failure?.message ?? errorMessage(error)))
}

/** Publish a navigation invalidation event after every persisted user-visible
 *  Clarus transition. Broad invalidation — the frontend refetches the full
 *  navigation snapshot via GET /global/clarus/navigation on receipt.
 *  Best-effort: never block a transition on publication. */
function publishNavigationUpdated(): void {
  try {
    void Bus.publish(NavigationUpdated, { timestamp: Date.now() })
  } catch {
    // Ignore — navigation events are best-effort.
  }
}

function trackSessionBinding(sessionID: string, agentId: string, projectId: string, taskId: string): void {
  if (sessionBindings.has(sessionID)) {
    sessionBindings.delete(sessionID)
  } else if (sessionBindings.size >= MAX_SESSION_BINDING_CACHE) {
    const firstKey = sessionBindings.keys().next().value
    if (firstKey !== undefined) sessionBindings.delete(firstKey)
  }
  sessionBindings.set(sessionID, { agentId, projectId, taskId })
}

function estimateEventBytes(event: ClarusObservedEvent): number {
  return new TextEncoder().encode(canonicalJSON(event)).byteLength
}

async function persistReconciliationOverflow(agentId: string, generation: number): Promise<void> {
  await Storage.update<ClarusReconciliationState>(StoragePath.clarusReconciliation(agentId), (state) => {
    state.schemaVersion = 1
    state.agentId = agentId
    state.generation = generation
    state.needsReconciliation = true
    state.lastError = "reconciliation event queue overflow"
  })
}

async function bufferObservedEvent(run: ActiveReconciliation, event: ClarusObservedEvent): Promise<void> {
  const bytes = estimateEventBytes(event)
  if (run.bufferedEvents.length >= MAX_BUFFERED_EVENTS || run.bufferedBytes + bytes > MAX_BUFFERED_EVENT_BYTES) {
    if (!run.overflowed) {
      run.overflowed = true
      await persistReconciliationOverflow(run.agentId, run.generation)
    }
    return
  }
  run.bufferedEvents.push(event)
  run.bufferedBytes += bytes
}

let rotationIndex = 0

async function loadRotationIndex(agentId: string): Promise<number> {
  const raw = await Storage.read<{ index: number }>(rotationPath(agentId)).catch(() => undefined)
  if (raw?.index !== undefined && Number.isFinite(raw.index) && raw.index > 0) {
    return raw.index % MAX_ROTATION_INDEX
  }
  return 0
}

async function persistRotationIndex(agentId: string, index: number): Promise<void> {
  await Storage.write(rotationPath(agentId), { index: index % MAX_ROTATION_INDEX })
}

function rotationPath(agentId: string): string[] {
  return [...StoragePath.clarusReconciliation(agentId), "rotation"]
}

export namespace ClarusRuntime {
  export function configureRest(port: ClarusRestPort.Interface | null): void {
    restPort = port
  }

  export function configureScheduler(nextScheduler: Scheduler | null): void {
    scheduler = nextScheduler ?? new ProductionScheduler()
  }

  export async function attach(port: ClarusAgentTunnelPort): Promise<() => void> {
    detach()
    const epoch = attachmentEpoch
    const config = await ClarusConfigReader.resolve()
    if (attachmentEpoch !== epoch || !config.enabled) return () => {}
    ClarusWorkspace.configure({ workspaceRoot: config.workspaceRoot })
    const eventUnregister = port.registerEventHandler(async (event) => {
      if (attachmentEpoch !== epoch || !isCurrentObservedEvent(event)) return
      const reconciliation = activeReconciliation
      if (reconciliation) {
        await bufferObservedEvent(reconciliation, event)
        return
      }
      await handleObservedEvent(event)
    })
    const connectionUnregister = port.registerConnectionHandler(async (event) => {
      if (attachmentEpoch !== epoch) return
      await handleConnectionEvent(event, port)
    })
    attached = { port, eventUnregister, connectionUnregister, epoch }
    subscribeSessionEvents()
    return () => {
      if (attached?.epoch === epoch) detach()
    }
  }

  export function detach(): void {
    const reconciliation = activeReconciliation
    if (reconciliation) {
      reconciliation.abortController.abort()
      activeReconciliation = null
    }
    unsubscribeSessionEvents()
    sessionBindings.clear()
    cancelAllDeadlineGuards()
    periodicTimer?.[Symbol.dispose]()
    periodicTimer = null
    periodicReconciliationActive = false
    connectedAgentId = null
    connectedEpoch = 0
    connectedGeneration = 0
    const previous = attached
    attached = null
    sendInFlight.clear()
    ++attachmentEpoch
    previous?.eventUnregister()
    previous?.connectionUnregister()
  }

  export function isAttached(): boolean {
    return attached !== null
  }

  export function init(): Promise<void> {
    if (initPromise) return initPromise

    initPromise = (async () => {
      let succeeded = false
      try {
        const config = await ClarusConfigReader.resolve()
        if (!config.enabled) {
          succeeded = true
          return
        }

        holosStatusUnsubscribe = Bus.subscribe(HolosRuntime.Event.StatusChanged, (event) => {
          const s = event.properties.status as HolosRuntimeType.Status["status"]
          if (s === "failed") {
            holosTransportStatus = { status: "failed", error: event.properties.error ?? "connection blocked" }
          } else {
            holosTransportStatus = { status: s }
          }
        })

        try {
          holosTransportStatus = await HolosRuntime.status()
        } catch {
          // keep default disconnected
        }

        try {
          const tunnel = await HolosRuntime.getNativeTunnel()
          const adapter = createClarusAgentTunnelAdapter(tunnel)
          await attach(adapter)
        } catch (error) {
          log.warn("Clarus init failed to attach to Holos tunnel", { error: errorMessage(error) })
          // Clean up the Bus subscription if attachment failed — allows retry
          if (holosStatusUnsubscribe) {
            holosStatusUnsubscribe()
            holosStatusUnsubscribe = null
          }
          return
        }
        succeeded = true
      } catch (error) {
        if (holosStatusUnsubscribe) {
          holosStatusUnsubscribe()
          holosStatusUnsubscribe = null
        }
        log.warn("Clarus init failed", { error: errorMessage(error) })
        throw error
      } finally {
        if (!succeeded) initPromise = null
      }
    })()

    return initPromise
  }

  export async function status(): Promise<ClarusRuntimeStatus> {
    const config = await ClarusConfigReader.resolve()
    if (!config.enabled) {
      return { agentId: null, status: "disabled", epoch: 0, generation: 0, isReconciling: false }
    }

    const hs = holosTransportStatus

    if (hs.status === "disabled") {
      return { agentId: null, status: "disabled", epoch: 0, generation: 0, isReconciling: false }
    }

    if (hs.status === "failed") {
      return {
        agentId: connectedAgentId,
        status: "blocked",
        epoch: connectedEpoch,
        generation: connectedGeneration,
        isReconciling: false,
        error: "connection blocked",
      }
    }

    if (hs.status === "connecting") {
      return {
        agentId: connectedAgentId,
        status: wasConnected ? "reconnecting" : "connecting",
        epoch: connectedEpoch,
        generation: connectedGeneration,
        isReconciling: false,
      }
    }

    if (hs.status === "connected") {
      if (!attached || !connectedAgentId) {
        return { agentId: null, status: "disconnected", epoch: 0, generation: 0, isReconciling: false }
      }
      return {
        agentId: connectedAgentId,
        status: "connected",
        epoch: connectedEpoch,
        generation: connectedGeneration,
        isReconciling: activeReconciliation !== null,
      }
    }

    return { agentId: null, status: "disconnected", epoch: 0, generation: 0, isReconciling: false }
  }

  export async function reconnect(): Promise<ClarusRuntimeStatus> {
    try {
      await HolosRuntime.reload()
    } catch (error) {
      log.warn("Clarus Holos reload failed", { error: errorMessage(error) })
      return status()
    }

    try {
      const config = await ClarusConfigReader.resolve()
      if (config.enabled) {
        const tunnel = await HolosRuntime.getNativeTunnel()
        const adapter = createClarusAgentTunnelAdapter(tunnel)
        await attach(adapter)
      }
    } catch (error) {
      log.warn("Clarus reconnect attach failed", { error: errorMessage(error) })
    }

    return status()
  }

  export function shutdown(): void {
    detach()
    if (holosStatusUnsubscribe) {
      holosStatusUnsubscribe()
      holosStatusUnsubscribe = null
    }
    initPromise = null
    wasConnected = false
    holosTransportStatus = { status: "disconnected" }
  }

  export async function recordTaskResult(
    input: RecordTaskResultInput & { agentId: string; projectId: string },
  ): Promise<unknown> {
    const transport = attached
    if (!transport) throw new Error("ClarusRuntime is not attached")
    if (!input.taskID || connectedAgentId !== input.agentId || connectedEpoch === 0 || connectedGeneration === 0) {
      throw new Error("Clarus result identity is not bound to the active connection")
    }
    const binding = await ClarusTaskBindingStore.get(input.agentId, input.projectId, input.taskID)
    if (
      !binding ||
      binding.runID !== input.runID ||
      binding.subtaskID !== input.subtaskID ||
      binding.agentId !== input.agentId ||
      binding.projectId !== input.projectId ||
      binding.taskId !== input.taskID
    ) {
      throw new Error("Clarus result identity does not match the active task binding")
    }
    if (
      binding.resultState === "local_only" ||
      isStatusTerminal(binding.status) ||
      binding.resultOutboxRequestID !== undefined
    ) {
      throw new Error("Clarus task result is already terminal or in flight")
    }

    const requestID = input.requestID
    await ClarusOutbox.preallocate({
      requestID,
      action: "task_result",
      agentId: input.agentId,
      projectId: input.projectId,
      taskId: input.taskID,
      runId: input.runID,
      subtaskId: input.subtaskID,
      payload: input.payload,
      connectionEpoch: String(connectedEpoch),
      generation: connectedGeneration,
    })
    let request: ReturnType<ClarusAgentTunnelPort["recordTaskResult"]>
    try {
      request = transport.port.recordTaskResult(input)
      if (request.requestID !== requestID) {
        await ClarusOutbox.markAmbiguous(requestID, "adapter returned a different request ID")
        throw new Error("Clarus result request ID mismatch")
      }
      await ClarusOutbox.markDispatched(requestID, {
        connectionEpoch: String(connectedEpoch),
        generation: connectedGeneration,
      })
      const response = await request.response
      if (response.requestID !== requestID) {
        await ClarusOutbox.markAmbiguous(requestID, "result response request ID did not match")
        throw new Error("Clarus result response request ID mismatch")
      }
      return response
    } catch (error) {
      const record = await ClarusOutbox.get(requestID)
      if (record?.state !== "ambiguous" && record?.state !== "acknowledged") {
        await settleOutboxFailure(requestID, error)
      }
      throw error
    }
  }

  const MAX_SEND_MESSAGE_TIMEOUT_MS = 30_000

  export async function sendProjectMessage(input: {
    requestID: string
    agentId: string
    projectId: string
    content: string
    messageType?: string
    fileRefs?: Array<Record<string, unknown>>
    userId?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<SendProjectMessageResult> {
    const transport = attached
    if (!transport) throw new Error("ClarusRuntime is not attached")
    if (!connectedAgentId || connectedAgentId !== input.agentId || connectedEpoch === 0 || connectedGeneration === 0) {
      throw new Error("Clarus sendProjectMessage: agent identity does not match the connected transport")
    }

    const requestID = input.requestID
    const agentId = input.agentId
    const projectId = input.projectId

    const payload = ClarusProjectMessagePayloadSchema.parse({
      content: input.content,
      ...(input.messageType !== undefined ? { messageType: input.messageType } : {}),
      ...(input.fileRefs !== undefined ? { fileRefs: input.fileRefs } : {}),
    }) as Record<string, unknown>

    // Terminal replay with identity validation — mismatches throw CLARUS_OUTBOX_COLLISION
    const existing = await ClarusOutbox.get(requestID)
    if (existing && isTerminalOutboxState(existing.state)) {
      validateOutboxIdentity(existing, {
        requestID,
        action: "project_message",
        agentId,
        projectId,
        userId: input.userId,
        payload,
      })
      if (existing.state === "acknowledged" && existing.acknowledgedPayload) {
        const ack = existing.acknowledgedPayload as Record<string, unknown>
        return {
          requestID,
          messageId: String((ack.messageId as string) ?? ""),
          projectId,
          senderId: String((ack.senderId as string) ?? agentId),
          ...(existing.userId ? { userId: existing.userId } : {}),
          epoch: existing.connectionEpoch ? Number(existing.connectionEpoch) : connectedEpoch,
          generation: existing.generation ?? connectedGeneration,
        }
      }
      if (existing.state === "rejected") {
        throw Object.assign(new Error(existing.errorMessage ?? "Clarus outbound message request was rejected"), {
          disposition: "rejected",
          requestID,
          code: existing.errorCode ?? "REJECTED",
        })
      }
      throw Object.assign(new Error(existing.errorMessage ?? "Clarus outbound message request is ambiguous"), {
        disposition: "ambiguous",
        requestID,
        reason: "disconnected",
      })
    }

    const payloadHashValue = payloadHash(payload)
    const inFlight = sendInFlight.get(requestID)
    if (inFlight) {
      if (
        inFlight.agentId !== agentId ||
        inFlight.projectId !== projectId ||
        inFlight.userId !== input.userId ||
        inFlight.payloadHash !== payloadHashValue ||
        !canonicalEqual(inFlight.payload, payload)
      ) {
        throw Object.assign(
          new Error(
            `Clarus outbox collision for requestID=${requestID}: existing has different identity, action, or payload`,
          ),
          { code: "CLARUS_OUTBOX_COLLISION" },
        )
      }
      return inFlight.promise
    }

    const operationPromise = (async (): Promise<SendProjectMessageResult> => {
      const binding = await ClarusBindingStore.readV3(agentId, projectId)
      if (!binding || !isActiveLifecycle(binding.lifecycle)) {
        throw new Error("Clarus sendProjectMessage: project is not active")
      }

      await ClarusOutbox.preallocate({
        requestID,
        action: "project_message",
        agentId,
        projectId,
        userId: input.userId,
        payload,
        connectionEpoch: String(connectedEpoch),
        generation: connectedGeneration,
      })

      const timeoutMs = Math.min(input.timeoutMs ?? MAX_SEND_MESSAGE_TIMEOUT_MS, MAX_SEND_MESSAGE_TIMEOUT_MS)

      let request: ReturnType<ClarusAgentTunnelPort["sendProjectMessage"]>
      try {
        request = transport.port.sendProjectMessage({
          requestID,
          projectID: projectId,
          content: input.content,
          ...(input.messageType !== undefined ? { messageType: input.messageType } : {}),
          ...(input.fileRefs !== undefined ? { fileRefs: input.fileRefs } : {}),
          timeoutMs,
          signal: input.signal,
        })
        if (request.requestID !== requestID) {
          await ClarusOutbox.markAmbiguous(requestID, "adapter returned a different request ID")
          throw Object.assign(new Error("Clarus sendProjectMessage: adapter returned a different request ID"), {
            disposition: "ambiguous",
            requestID,
            reason: "invalid_response",
          })
        }
      } catch (error) {
        const record = await ClarusOutbox.get(requestID)
        if (record?.state !== "ambiguous" && record?.state !== "acknowledged" && record?.state !== "rejected") {
          await settleOutboxFailure(requestID, error)
        }
        throw error
      }

      await ClarusOutbox.markDispatched(requestID, {
        connectionEpoch: String(connectedEpoch),
        generation: connectedGeneration,
      })

      try {
        const response = await request.response

        if (response.requestID !== requestID) {
          await ClarusOutbox.markAmbiguous(requestID, "response requestID did not match")
          throw Object.assign(new Error("Clarus sendProjectMessage: response requestID did not match"), {
            disposition: "ambiguous",
            requestID,
            reason: "invalid_response",
          })
        }
        if (response.agentID !== connectedAgentId) {
          await ClarusOutbox.markAmbiguous(requestID, "response agentID did not match connected transport")
          throw Object.assign(
            new Error("Clarus sendProjectMessage: response agentID did not match connected transport"),
            { disposition: "ambiguous", requestID, reason: "unexpected_response" },
          )
        }
        if (response.projectID !== projectId) {
          await ClarusOutbox.markAmbiguous(requestID, "response projectID did not match")
          throw Object.assign(new Error("Clarus sendProjectMessage: response projectID did not match"), {
            disposition: "ambiguous",
            requestID,
            reason: "unexpected_response",
          })
        }
        if (response.epoch !== connectedEpoch || response.generation !== connectedGeneration) {
          await ClarusOutbox.markAmbiguous(requestID, "response epoch/generation did not match connected transport")
          throw Object.assign(
            new Error("Clarus sendProjectMessage: response epoch/generation did not match connected transport"),
            { disposition: "ambiguous", requestID, reason: "unexpected_response" },
          )
        }

        const messageId = response.message.messageID
        const senderId = response.message.senderID
        await ClarusOutbox.markAcknowledged(requestID, {
          messageId,
          senderId,
          projectId,
          ...(input.userId ? { userId: input.userId } : {}),
        })

        return {
          requestID,
          messageId,
          projectId,
          senderId,
          ...(input.userId ? { userId: input.userId } : {}),
          epoch: connectedEpoch,
          generation: connectedGeneration,
        }
      } catch (error) {
        const record = await ClarusOutbox.get(requestID)
        if (record?.state !== "ambiguous" && record?.state !== "acknowledged" && record?.state !== "rejected") {
          await settleOutboxFailure(requestID, error)
        }
        throw error
      }
    })()

    sendInFlight.set(requestID, {
      promise: operationPromise,
      agentId,
      projectId,
      userId: input.userId,
      payloadHash: payloadHashValue,
      payload,
    })
    try {
      return await operationPromise
    } finally {
      sendInFlight.delete(requestID)
    }
  }
  export async function listUsers(input: {
    search: string
    limit?: number
    signal?: AbortSignal
  }): Promise<ClarusRestPort.UserCandidateDto[]> {
    if (input.signal?.aborted) {
      throw Object.assign(new Error("The operation was aborted"), {
        code: "CLARUS_USER_LOOKUP_ABORTED",
        recoverable: false,
      })
    }

    const search = input.search
    if (search.length > MAX_WIRE_STRING_USER_QUERY) {
      throw Object.assign(new Error("Clarus user search query exceeds its length limit"), {
        code: "CLARUS_INVALID_INPUT",
        recoverable: false,
      })
    }

    const limit = input.limit ?? MAX_USER_CANDIDATES
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_USER_CANDIDATES) {
      throw Object.assign(new Error("Clarus user lookup limit is out of bounds"), {
        code: "CLARUS_INVALID_INPUT",
        recoverable: false,
      })
    }

    const s = await status()
    if (s.status === "disabled") {
      throw Object.assign(new Error("Clarus is not enabled"), {
        code: "CLARUS_DISABLED",
        recoverable: false,
      })
    }
    if (s.status === "disconnected") {
      throw Object.assign(new Error("Clarus is not connected. Start Holos and enable Clarus."), {
        code: "CLARUS_NOT_CONNECTED",
        recoverable: false,
      })
    }
    if (s.status === "connecting" || s.status === "reconnecting") {
      throw Object.assign(new Error("Clarus connection is still being established. Retry shortly."), {
        code: "CLARUS_CONNECTING",
        recoverable: true,
      })
    }
    if (s.status === "blocked") {
      throw Object.assign(new Error(s.error ?? "Clarus connection is blocked."), {
        code: "CLARUS_BLOCKED",
        recoverable: false,
      })
    }

    const port = restPort
    if (!port) {
      throw Object.assign(new Error("Clarus REST port is not configured"), {
        code: "CLARUS_REST_NOT_CONFIGURED",
        recoverable: false,
      })
    }

    try {
      const listPromise = port.listUsers({ query: search, limit })
      if (!input.signal) {
        const result = await listPromise
        return result.users
      }

      const abortError = Object.assign(new Error("The operation was aborted"), {
        code: "CLARUS_USER_LOOKUP_ABORTED",
        recoverable: false,
      })
      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (input.signal!.aborted) {
          reject(abortError)
          return
        }
        const onAbort = () => {
          reject(abortError)
        }
        input.signal!.addEventListener("abort", onAbort, { once: true })
      })
      const result = await Promise.race([listPromise, abortPromise])
      return result.users
    } catch (error) {
      if (isRecord(error) && typeof error.code === "string") throw error
      throw Object.assign(new Error(sanitizeErrorText(errorMessage(error))), {
        code: "CLARUS_COMPOSER_USERS_ERROR",
        recoverable: false,
      })
    }
  }
}

async function handleConnectionEvent(event: HolosConnectionEvent, port: ClarusAgentTunnelPort): Promise<void> {
  if (event.type === "disconnected") {
    if (
      connectedAgentId !== event.agentID ||
      event.epoch < connectedEpoch ||
      (event.epoch === connectedEpoch && event.generation < connectedGeneration)
    )
      return
    const reconciliation = activeReconciliation
    if (reconciliation?.agentId === event.agentID) {
      reconciliation.abortController.abort()
    }
    connectedAgentId = null
    connectedEpoch = 0
    connectedGeneration = 0
    holosTransportStatus = { status: "disconnected" }
    periodicTimer?.[Symbol.dispose]()
    periodicTimer = null
    if (activeReconciliation?.agentId === event.agentID) {
      activeReconciliation = null
    }
    publishNavigationUpdated()
    return
  }
  if (
    connectedAgentId === event.agentID &&
    (event.epoch < connectedEpoch || (event.epoch === connectedEpoch && event.generation <= connectedGeneration))
  )
    return
  connectedAgentId = event.agentID
  connectedEpoch = event.epoch
  connectedGeneration = event.generation
  wasConnected = true
  holosTransportStatus = { status: "connected" }
  publishNavigationUpdated()
  if (
    activeReconciliation &&
    activeReconciliation.agentId === event.agentID &&
    activeReconciliation.epoch === event.epoch &&
    activeReconciliation.generation >= event.generation
  )
    return
  cancelAllDeadlineGuards()
  await restoreDeadlineGuards(event.agentID)
  if (!restPort) return
  const run: ActiveReconciliation = {
    agentId: event.agentID,
    epoch: event.epoch,
    generation: event.generation,
    bufferedEvents: [],
    bufferedBytes: 0,
    overflowed: false,
    abortController: new AbortController(),
    startedAt: Date.now(),
  }
  activeReconciliation = run
  await setReconciliationNeeded(event.agentID, event.generation)
  void reconcile({ port, run })
  startPeriodicDiscovery(port)
}

async function restoreDeadlineGuards(agentId: string): Promise<void> {
  const bindings = await ClarusBindingStore.listBindings(agentId)
  for (const binding of bindings) {
    if (!binding.desiredSubscription) continue
    const taskBindings = await ClarusTaskBindingStore.listTaskBindings(agentId, binding.projectId)
    for (const task of taskBindings) {
      if (task.status !== "running" || !task.deadlineAt) continue
      scheduleDeadlineGuard({
        agentId,
        projectId: task.projectId,
        taskId: task.taskId,
        runID: task.runID,
        deadlineAt: task.deadlineAt,
      })
    }
  }
}

function startPeriodicDiscovery(port: ClarusAgentTunnelPort): void {
  periodicTimer?.[Symbol.dispose]()
  const tick = () => {
    if (
      !attached ||
      attached.port !== port ||
      !connectedAgentId ||
      periodicReconciliationActive ||
      activeReconciliation
    ) {
      if (attached?.port === port && connectedAgentId) periodicTimer = scheduler.schedule(DISCOVERY_INTERVAL_MS, tick)
      return
    }
    periodicReconciliationActive = true
    const run: ActiveReconciliation = {
      agentId: connectedAgentId,
      epoch: connectedEpoch,
      generation: connectedGeneration,
      bufferedEvents: [],
      bufferedBytes: 0,
      overflowed: false,
      abortController: new AbortController(),
      startedAt: Date.now(),
    }
    activeReconciliation = run
    void reconcile({ port, run }).finally(() => {
      periodicReconciliationActive = false
    })
    if (attached?.port === port) periodicTimer = scheduler.schedule(DISCOVERY_INTERVAL_MS, tick)
  }
  periodicTimer = scheduler.schedule(DISCOVERY_INTERVAL_MS, tick)
}

async function handleObservedEvent(event: ClarusObservedEvent): Promise<void> {
  if (!isCurrentObservedEvent(event)) return
  if (event.kind !== "known") {
    if (event.kind === "invalid") {
      const invalid: ClarusInvalidEvent = event
      log.warn("invalid Clarus event", { type: invalid.sourceType, issues: invalid.issues })
    }
    return
  }
  switch (event.type) {
    case "projectSubscribed":
      await settleProjectSubscription(event)
      return
    case "projectUnsubscribed":
      await settleProjectUnsubscription(event)
      return
    case "projectMessageCreated":
      await handleProjectMessageCreated(event)
      return
    case "runtimeTaskAssigned":
      await handleTaskAssigned(event)
      return
    case "runtimeTaskExtended":
      await handleTaskExtended(event)
      return
    case "runtimeTaskResultRecorded":
      await handleTaskResultRecorded(event)
      return
    case "projectSystemEvent":
      await handleSystemEvent(event)
      return
    case "projectFileUploaded":
    case "notaryRecordCreated":
      return
  }
}

async function settleProjectSubscription(event: ProjectSubscribedEvent): Promise<void> {
  if (event.requestID) await acknowledgeIfPresent(event.requestID)
}

async function settleProjectUnsubscription(event: ProjectUnsubscribedEvent): Promise<void> {
  if (event.requestID) await acknowledgeIfPresent(event.requestID)
}

type OutboxIdentity = {
  epoch: number
  generation: number
  action: ClarusOutboxAction
  agentId: string
  projectId: string
  taskId?: string
  runId?: string
  subtaskId?: string
}

async function acknowledgeIfPresent(requestID: string, identity?: OutboxIdentity): Promise<boolean> {
  const record = await ClarusOutbox.get(requestID)
  if (!record) return false
  if (identity) {
    if (
      String(identity.epoch) !== record.connectionEpoch ||
      identity.generation !== record.generation ||
      identity.action !== record.action ||
      identity.agentId !== record.agentId ||
      identity.projectId !== record.projectId ||
      identity.taskId !== record.taskId ||
      identity.runId !== record.runId ||
      identity.subtaskId !== record.subtaskId
    )
      return false
  }
  if (record.state === "acknowledged") return true
  if (record.state === "rejected" || record.state === "ambiguous" || record.state === "local_only") return false
  await ClarusOutbox.markAcknowledged(requestID)
  return true
}

async function handleProjectMessageCreated(event: ProjectMessageCreatedEvent): Promise<void> {
  const { agentID: agentId, projectID: projectId } = event
  const { messageID, senderID, content } = event.message
  if (senderID === agentId) {
    if (event.requestID) await acknowledgeIfPresent(event.requestID)
    return
  }
  const binding = await ClarusBindingStore.readV3(agentId, projectId)
  if (!binding || !isActiveLifecycle(binding.lifecycle)) return
  await ClarusProjectActivityStore.upsert({
    agentId,
    projectId,
    messageId: messageID,
    senderId: senderID,
    content,
    receivedAt: Date.now(),
  })
  await deliverProjectMessage({ agentId, projectId, messageId: messageID, text: content })
  await ClarusBindingStore.touchLastActivity(agentId, projectId, Date.now())
  publishNavigationUpdated()
}

async function handleTaskAssigned(event: RuntimeTaskAssignedEvent): Promise<void> {
  const agentId = event.agentID
  const projectId = event.projectID
  const taskId = event.taskID
  const binding = await ClarusBindingStore.readV3(agentId, projectId)
  if (!binding || !isActiveLifecycle(binding.lifecycle)) return
  const session = await getOrCreateTaskSession({ agentId, projectId, taskId })
  trackSessionBinding(session.id, agentId, projectId, taskId)
  const existing = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
  if (existing?.assignmentInboxItemID && existing.assignmentState !== "planned") return

  const resolution = await ClarusAgentResolver.resolveAgent({ projectPrimaryAgent: binding.primaryAgent })
  if ("error" in resolution) {
    log.error("no agent available for Clarus task", { taskId, error: resolution.error })
    return
  }
  const title = deriveTaskTitle(event)
  const taskInput = deriveTaskInput(event)
  const contextHydration = deriveContextHydration(event)
  await ClarusTaskBindingStore.updateAssignmentMetadata({
    agentId,
    projectId,
    taskId,
    runID: event.runID,
    phase: event.phase,
    subtaskID: event.subtaskID,
    attempt: event.attempt,
    deadlineAt: event.deadlineAt,
    frozenAgent: resolution.agentId,
    title,
    taskInput,
    contextHydration,
  })
  await deliverTaskMessage({
    agentId,
    projectId,
    taskId,
    messageId: `task_assign_${taskId}`,
    text: `Task assigned: ${title}, phase=${event.phase}, attempt=${event.attempt}`,
    extraMetadata: { clarusAssignment: { frozenAgent: resolution.agentId, runID: event.runID } },
  })
  if (event.deadlineAt) {
    scheduleDeadlineGuard({ agentId, projectId, taskId, runID: event.runID, deadlineAt: event.deadlineAt })
  }
  publishNavigationUpdated()
}

function deriveTaskTitle(event: RuntimeTaskAssignedEvent): string {
  if (event.goal?.trim()) return event.goal.trim()
  if (event.instructions?.trim()) return event.instructions.trim()
  if (event.context && typeof event.context.current_task === "string" && event.context.current_task.trim()) {
    return event.context.current_task.trim()
  }
  return event.taskID.length > 50 ? `${event.taskID.slice(0, 50)}…` : event.taskID
}

function deriveTaskInput(event: RuntimeTaskAssignedEvent): Record<string, unknown> {
  const taskInput: Record<string, unknown> = {}
  if (event.taskInput) Object.assign(taskInput, event.taskInput)
  if (event.goal !== null && event.goal !== undefined) taskInput.goal = event.goal
  if (event.instructions !== null && event.instructions !== undefined) taskInput.instructions = event.instructions
  if (event.input) taskInput.input = event.input
  if (event.context) taskInput.context = event.context
  return taskInput
}

function deriveContextHydration(event: RuntimeTaskAssignedEvent): ClarusTaskContextHydration {
  const hasTaskInput = event.taskInput !== null && event.taskInput !== undefined
  const hasContext = event.context !== null && event.context !== undefined
  if (hasTaskInput && hasContext) return "complete"
  if (hasTaskInput || hasContext || (event.input !== null && event.input !== undefined)) return "partial"
  return "unavailable"
}

async function handleTaskExtended(event: RuntimeTaskExtendedEvent): Promise<void> {
  const taskId = event.task.taskID
  const binding = await ClarusTaskBindingStore.get(event.agentID, event.projectID, taskId)
  if (!binding || binding.runID !== event.runID) return
  const updated = await ClarusTaskBindingStore.updateExtension(
    event.agentID,
    event.projectID,
    taskId,
    event.task.deadlineAt,
  )
  if (!updated) return
  if (event.requestID) await acknowledgeIfPresent(event.requestID)
  if (event.task.deadlineAt) {
    scheduleDeadlineGuard({
      agentId: event.agentID,
      projectId: event.projectID,
      taskId,
      runID: event.runID,
      deadlineAt: event.task.deadlineAt,
    })
  }
}

async function handleTaskResultRecorded(event: RuntimeTaskResultRecordedEvent): Promise<void> {
  const taskId = event.task.taskID
  const binding = await ClarusTaskBindingStore.get(event.agentID, event.projectID, taskId)
  if (!binding || binding.runID !== event.runID || binding.subtaskID !== event.task.subtaskID) return
  if (
    binding.resultState === "local_only" ||
    binding.resultState === "acknowledged" ||
    binding.resultState === "ambiguous" ||
    binding.resultState === "rejected"
  )
    return
  if (binding.status !== "running" && binding.status !== "submitting") return
  if (!event.requestID || binding.resultOutboxRequestID !== event.requestID) return
  const identity: OutboxIdentity = {
    epoch: event.epoch,
    generation: event.generation,
    action: "task_result",
    agentId: event.agentID,
    projectId: event.projectID,
    taskId: event.task.taskID,
    runId: event.runID,
    subtaskId: event.task.subtaskID,
  }
  if (!(await acknowledgeIfPresent(event.requestID, identity))) return
  await ClarusTaskBindingStore.markCompleted({ agentId: event.agentID, projectId: event.projectID, taskId })
  cancelDeadlineGuard(event.agentID, event.projectID, taskId)
  sessionBindings.delete(binding.sessionID)
  publishNavigationUpdated()
}

async function handleSystemEvent(event: ProjectSystemEvent): Promise<void> {
  if (event.eventType === "archive" || event.eventType === "delete" || event.eventType === "current-agent-left") {
    await evictProjectResources(event.agentID, event.projectID)
    await ClarusBindingStore.setInactive(event.agentID, event.projectID)
    publishNavigationUpdated()
    return
  }
  if (event.eventType === "agent_joined" || event.eventType === "current-agent") {
    const binding = await ClarusBindingStore.readV3(event.agentID, event.projectID)
    if (!binding) await triggerDiscovery(event.agentID)
  }
}

async function evictProjectResources(agentId: string, projectId: string): Promise<void> {
  const taskBindings = await ClarusTaskBindingStore.listTaskBindings(agentId, projectId)
  for (const task of taskBindings) {
    cancelDeadlineGuard(agentId, projectId, task.taskId)
    sessionBindings.delete(task.sessionID)
  }
}

async function triggerDiscovery(agentId: string): Promise<void> {
  const transport = attached
  if (!transport || connectedAgentId !== agentId) return
  const run: ActiveReconciliation = {
    agentId,
    epoch: connectedEpoch,
    generation: connectedGeneration + 1,
    bufferedEvents: [],
    bufferedBytes: 0,
    overflowed: false,
    abortController: new AbortController(),
    startedAt: Date.now(),
  }
  activeReconciliation = run
  await setReconciliationNeeded(agentId, run.generation)
  void reconcile({ port: transport.port, run })
}

async function setReconciliationNeeded(agentId: string, generation: number): Promise<void> {
  const state: ClarusReconciliationState = {
    schemaVersion: 1,
    agentId,
    generation,
    needsReconciliation: true,
  }
  await Storage.write(StoragePath.clarusReconciliation(agentId), state)
}

async function persistReconciliationError(agentId: string, generation: number, error: unknown): Promise<void> {
  const state: ClarusReconciliationState = {
    schemaVersion: 1,
    agentId,
    generation,
    needsReconciliation: true,
    lastError: errorMessage(error),
  }
  await Storage.write(StoragePath.clarusReconciliation(agentId), state)
}

async function reconcile(input: { port: ClarusAgentTunnelPort; run: ActiveReconciliation }): Promise<void> {
  const { port, run } = input
  if (isRunAbortedOrStale(run)) return
  try {
    const rest = restPort
    if (!rest) {
      if (!isRunAbortedOrStale(run))
        await persistReconciliationError(run.agentId, run.generation, "No REST port configured")
      return
    }
    const knownProjectIds = new Set<string>()
    let subscriptionError: string | undefined
    let cursor: string | undefined
    let nonProgressingCount = 0
    let discoveryPages = 0
    let discoveryTruncated = false
    do {
      if (isRunAbortedOrStale(run)) return
      if (discoveryPages >= MAX_DISCOVERY_PAGES) {
        discoveryTruncated = true
        break
      }
      const previousCursor = cursor
      const page = await rest.listProjects({ status: "active", limit: 50, cursor })
      if (isRunAbortedOrStale(run)) return
      discoveryPages++
      if (page.nextCursor === previousCursor) {
        nonProgressingCount++
        if (nonProgressingCount >= MAX_NON_PROGRESSING_PAGES) break
      } else {
        nonProgressingCount = 0
      }
      for (const project of page.projects) {
        knownProjectIds.add(project.projectId)
        const binding = await ClarusBindingStore.reconcileBinding({
          agentId: run.agentId,
          projectId: project.projectId,
          projectName: project.title,
          projectStatus: project.status,
          primaryAgent: project.runtimeAgentId,
        })
        if (!binding.desiredSubscription) continue
        const subscription = await reconcileProjectSubscription(port, run, binding)
        if (!subscription.ok && !subscriptionError) subscriptionError = subscription.error
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    // Only archive after a complete discovery sweep, not a partial budgeted cycle
    if (!discoveryTruncated) {
      await ClarusBindingStore.archiveMissing(run.agentId, knownProjectIds)
    }

    // Read active bindings with bounded cursor
    let bc: string | undefined
    let br = 0
    const activeBindings: ClarusProjectBindingV3[] = []
    while (br < MAX_DISCOVERY_BINDINGS_READ) {
      const bp = await ClarusBindingStore.listBindingsBounded(run.agentId, { limit: 100, cursor: bc })
      if (bp.items.length === 0) break
      for (const b of bp.items) {
        if (b.desiredSubscription) activeBindings.push(b)
        br++
        if (br >= MAX_DISCOVERY_BINDINGS_READ) break
      }
      if (!bp.nextCursor) break
      bc = bp.nextCursor
    }
    if (activeBindings.length === 0) {
      if (!isRunAbortedOrStale(run)) {
        await Storage.write(StoragePath.clarusReconciliation(run.agentId), {
          schemaVersion: 1,
          agentId: run.agentId,
          generation: run.generation,
          needsReconciliation: subscriptionError !== undefined || run.overflowed,
          ...(subscriptionError || run.overflowed
            ? { lastError: subscriptionError ?? "reconciliation event queue overflow" }
            : {}),
          ...(subscriptionError || run.overflowed ? {} : { lastReconciledAt: Date.now() }),
        } satisfies ClarusReconciliationState)
      }
      if (!isRunAbortedOrStale(run)) await drainBufferedEvents(run)
      return
    }
    let exhausted = false
    rotationIndex = await loadRotationIndex(run.agentId)
    let projectIndex = rotationIndex
    const budget = { remaining: BACKFILL_PAGE_BUDGET_PER_CYCLE }
    let completedProjects = 0

    while (budget.remaining > 0 && !exhausted && completedProjects < activeBindings.length) {
      if (isRunAbortedOrStale(run)) return
      const binding = activeBindings[projectIndex % activeBindings.length]
      const before = budget.remaining
      const result = await backfillProjectMessages(binding, budget)
      const consumed = before - budget.remaining
      if (result === "exhausted") {
        exhausted = true
      }
      if (result === "complete" || consumed === 0) {
        completedProjects++
      }
      projectIndex++
    }

    if (!isRunAbortedOrStale(run)) {
      await persistRotationIndex(run.agentId, projectIndex)
    }

    if (!isRunAbortedOrStale(run)) {
      await Storage.write(StoragePath.clarusReconciliation(run.agentId), {
        schemaVersion: 1,
        agentId: run.agentId,
        generation: run.generation,
        needsReconciliation: exhausted || subscriptionError !== undefined || run.overflowed,
        ...(subscriptionError || run.overflowed
          ? { lastError: subscriptionError ?? "reconciliation event queue overflow" }
          : {}),
        ...(exhausted ? {} : { lastReconciledAt: Date.now() }),
      } satisfies ClarusReconciliationState)
    }
    if (!isRunAbortedOrStale(run)) await drainBufferedEvents(run)
  } catch (error) {
    if (isCurrentReconciliation(run) && !run.abortController.signal.aborted) {
      await persistReconciliationError(run.agentId, run.generation, error)
      await drainBufferedEvents(run)
    }
  } finally {
    if (isCurrentReconciliation(run)) activeReconciliation = null
  }
}

async function drainBufferedEvents(run: ActiveReconciliation): Promise<void> {
  while (isCurrentReconciliation(run) && !run.abortController.signal.aborted) {
    const event = run.bufferedEvents.shift()
    if (!event) return
    run.bufferedBytes -= estimateEventBytes(event)
    await handleObservedEvent(event)
  }
}

function subscriptionIndexPath(agentId: string, projectId: string): string[] {
  return ["clarus", "subscription_index", encodeURIComponent(agentId), encodeURIComponent(projectId)]
}

async function subscriptionAlreadyReconciled(
  agentId: string,
  projectId: string,
  epoch: number,
  generation: number,
): Promise<boolean> {
  const index = await Storage.read<{ epoch: number; generation: number }>(
    subscriptionIndexPath(agentId, projectId),
  ).catch(() => undefined)
  return index !== undefined && index.epoch === epoch && index.generation >= generation
}
async function persistSubscriptionIndex(
  agentId: string,
  projectId: string,
  epoch: number,
  generation: number,
): Promise<void> {
  await Storage.write(subscriptionIndexPath(agentId, projectId), { epoch, generation })
}

async function reconcileProjectSubscription(
  port: ClarusAgentTunnelPort,
  run: ActiveReconciliation,
  binding: ClarusProjectBindingV3,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await subscriptionAlreadyReconciled(run.agentId, binding.projectId, run.epoch, run.generation)) {
    return { ok: true }
  }
  const requestID = crypto.randomUUID()
  await ClarusOutbox.preallocate({
    requestID,
    action: "project_subscribe",
    agentId: run.agentId,
    projectId: binding.projectId,
    payload: { generation: run.generation, project_id: binding.projectId },
    generation: run.generation,
  })
  let request: ReturnType<ClarusAgentTunnelPort["subscribeProject"]>
  try {
    request = port.subscribeProject({ projectID: binding.projectId, requestID })
    if (request.requestID !== requestID) {
      const error = `subscription request ID mismatch: expected ${requestID}, received ${request.requestID}`
      await ClarusOutbox.markAmbiguous(requestID, error)
      void request.response.catch(() => undefined)
      return { ok: false, error }
    }
    await ClarusOutbox.markDispatched(requestID)
    await persistSubscriptionIndex(run.agentId, binding.projectId, run.epoch, run.generation)
  } catch (error) {
    await settleOutboxFailure(requestID, error)
    return { ok: false, error: errorMessage(error) }
  }
  try {
    const response = await request.response
    if (response.requestID !== requestID) {
      const error = `subscription response request ID mismatch: expected ${requestID}, received ${response.requestID}`
      await ClarusOutbox.markAmbiguous(requestID, error)
      return { ok: false, error }
    }
    await ClarusOutbox.markAcknowledged(requestID)
    return { ok: true }
  } catch (error) {
    await settleOutboxFailure(requestID, error)
    return { ok: false, error: errorMessage(error) }
  }
}

async function backfillProjectMessages(
  binding: ClarusProjectBindingV3,
  budget: { remaining: number },
): Promise<"complete" | "exhausted"> {
  const rest = restPort
  if (!rest) return "complete"
  let cursor = binding.messageCursor ?? undefined
  let nonProgressingPages = 0
  do {
    if (budget.remaining <= 0) return "exhausted"
    const page = await rest.listMessages({
      projectId: binding.projectId,
      cursor,
      limit: Math.min(50, budget.remaining),
    })
    const previousCursor = cursor
    cursor = page.nextCursor ?? undefined
    if (cursor === previousCursor) {
      nonProgressingPages++
      if (nonProgressingPages >= MAX_NON_PROGRESSING_PAGES) return "exhausted"
    } else {
      nonProgressingPages = 0
    }
    budget.remaining--
    for (const message of page.messages) {
      await ClarusProjectActivityStore.upsert({
        agentId: binding.agentId,
        projectId: binding.projectId,
        messageId: message.messageId,
        messageType: message.messageType,
        content: message.content,
        fileRefs: message.fileRefs,
        metadata: message.metadata,
        createdAt: message.createdAt,
        receivedAt: Date.now(),
      })
      await backfillAssignment(binding, message)
    }
    if (cursor !== binding.messageCursor) {
      using _ = await Lock.write(
        `clarus:backfill:${encodeURIComponent(binding.agentId)}:${encodeURIComponent(binding.projectId)}`,
      )
      const fresh = await ClarusBindingStore.readV3(binding.agentId, binding.projectId)
      if (fresh && fresh.messageCursor === binding.messageCursor) {
        const updated: ClarusProjectBindingV3 = {
          ...fresh,
          messageCursor: cursor ?? null,
          updatedAt: Date.now(),
        }
        await Storage.write(StoragePath.clarusShardProjectBinding(binding.agentId, binding.projectId), updated)
        binding = updated
      }
    }
    if (!cursor) return "complete"
    if (budget.remaining <= 0) return "exhausted"
  } while (cursor)
  return "complete"
}

async function backfillAssignment(binding: ClarusProjectBindingV3, message: ClarusRestPort.MessageDto): Promise<void> {
  const metadata = message.metadata
  if (!isRecord(metadata) || metadata.event_type !== "clarus.runtime.task.assigned") return
  const payload = metadata.payload
  if (!isRecord(payload) || typeof payload.task_id !== "string") return
  try {
    await deliverTaskMessage({
      agentId: binding.agentId,
      projectId: binding.projectId,
      taskId: payload.task_id,
      messageId: message.messageId,
      text: message.content ?? "Task assigned",
      extraMetadata: { clarusMessage: { messageID: message.messageId, metadata } },
    })
    await ClarusBindingStore.touchLastActivity(binding.agentId, binding.projectId, Date.now())
  } catch (error) {
    log.info("Clarus assignment backfill deferred", { projectId: binding.projectId, error: errorMessage(error) })
  }
}

async function dispatchResultForSession(sessionID: string, isError: boolean): Promise<void> {
  const transport = attached
  if (!transport) return
  const identity = sessionBindings.get(sessionID) ?? (await findSessionBinding(sessionID))
  if (!identity) return
  sessionBindings.set(sessionID, identity)
  const binding = await ClarusTaskBindingStore.get(identity.agentId, identity.projectId, identity.taskId)
  if (!binding || binding.sessionID !== sessionID) return
  if (binding.status !== "running" || binding.resultOutboxRequestID || binding.localContinuationEnabledAt) return
  if (!isError && binding.contextHydration !== "complete") {
    await ClarusTaskBindingStore.markNeedsAttention(identity.agentId, identity.projectId, identity.taskId)
    cancelDeadlineGuard(identity.agentId, identity.projectId, identity.taskId)
    sessionBindings.delete(sessionID)
    publishNavigationUpdated()
    return
  }

  const requestID = crypto.randomUUID()
  const content = await deriveResultContent(binding, sessionID, isError)
  if (!content) {
    await ClarusTaskBindingStore.markNeedsAttention(identity.agentId, identity.projectId, identity.taskId)
    cancelDeadlineGuard(identity.agentId, identity.projectId, identity.taskId)
    sessionBindings.delete(sessionID)
    publishNavigationUpdated()
    return
  }
  await ClarusOutbox.preallocate({
    requestID,
    action: "task_result",
    agentId: identity.agentId,
    projectId: identity.projectId,
    taskId: identity.taskId,
    runId: binding.runID,
    subtaskId: binding.subtaskID,
    connectionEpoch: String(connectedEpoch),
    generation: connectedGeneration,
    payload: { output: content.output, success: !isError },
  })
  const claimed = await ClarusTaskBindingStore.markSubmitting({
    agentId: identity.agentId,
    projectId: identity.projectId,
    taskId: identity.taskId,
    resultOutboxRequestID: requestID,
    lastCompletedAssistantMessageID: binding.lastCompletedAssistantMessageID,
  })
  if (!claimed || claimed.resultOutboxRequestID !== requestID) {
    await ClarusOutbox.markAmbiguous(requestID, "concurrent result dispatch lost ownership")
    return
  }
  publishNavigationUpdated()

  let request: ReturnType<ClarusAgentTunnelPort["recordTaskResult"]>
  try {
    request = transport.port.recordTaskResult({
      requestID,
      runID: binding.runID,
      taskID: identity.taskId,
      subtaskID: binding.subtaskID,
      success: !isError,
      output: content.output,
      artifacts: content.artifacts,
      evidenceRefs: content.evidenceRefs,
      notaryRefs: [],
      error: isError ? `Session ${sessionID} ended with error` : null,
      payload: { task_id: identity.taskId },
    })
    if (request.requestID !== requestID) {
      await ClarusOutbox.markAmbiguous(requestID, "adapter returned a different request ID")
      await ClarusTaskBindingStore.revertSubmitting(identity.agentId, identity.projectId, identity.taskId)
      sessionBindings.delete(sessionID)
      publishNavigationUpdated()
      return
    }
    await ClarusOutbox.markDispatched(requestID)
  } catch (error) {
    await settleResultFailure(identity, requestID, error)
    return
  }
  try {
    const response = await request.response
    if (response.requestID !== requestID) {
      await ClarusOutbox.markAmbiguous(requestID, "result response request ID did not match")
      await ClarusTaskBindingStore.revertSubmitting(identity.agentId, identity.projectId, identity.taskId)
      sessionBindings.delete(sessionID)
      publishNavigationUpdated()
      return
    }
    // The response only confirms dispatch; the recorded event owns acknowledgement.
  } catch (error) {
    await settleResultFailure(identity, requestID, error)
  }
}

async function settleResultFailure(
  identity: { agentId: string; projectId: string; taskId: string },
  requestID: string,
  error: unknown,
): Promise<void> {
  await settleOutboxFailure(requestID, error)
  await ClarusTaskBindingStore.revertSubmitting(identity.agentId, identity.projectId, identity.taskId)
  cancelDeadlineGuard(identity.agentId, identity.projectId, identity.taskId)
  publishNavigationUpdated()
}

async function findSessionBinding(
  sessionID: string,
): Promise<{ agentId: string; projectId: string; taskId: string } | undefined> {
  const binding = await ClarusTaskBindingStore.findBySessionID(sessionID)
  if (!binding) return undefined
  return { agentId: binding.agentId, projectId: binding.projectId, taskId: binding.taskId }
}

async function deriveResultContent(
  binding: {
    scopeID: string
    taskId: string
    title: string
  },
  sessionID: string,
  isError: boolean,
): Promise<{ output: string; artifacts: Array<Record<string, unknown>>; evidenceRefs: string[] } | null> {
  if (isError) return { output: `Task failed: ${binding.title}`, artifacts: [], evidenceRefs: [] }
  const output = await readLatestAssistantOutput(binding.scopeID, sessionID)
  if (!output) return null
  const artifactID = `result-${binding.taskId}`
  return {
    output: output.preview,
    artifacts: [
      {
        artifact_id: artifactID,
        name: "result.md",
        parts: [{ type: "text", format: "markdown", role: "specialist_output", content: output.body }],
      },
    ],
    evidenceRefs: [artifactID],
  }
}

const MAX_RESULT_BODY_LENGTH = 100_000

async function readLatestAssistantOutput(
  _scopeID: string,
  sessionID: string,
): Promise<{ preview: string; body: string } | null> {
  const [{ SessionHistory }, { MessageV2 }] = await Promise.all([
    import("@/session/history"),
    import("@/session/message-v2"),
  ])
  const messages = await SessionHistory.messages({ sessionID, limit: 50 })
  for (const message of [...messages].reverse()) {
    if (message.info.role !== "assistant" || !message.info.time.completed) continue
    const body = MessageV2.extractText(message.parts, { maxLength: MAX_RESULT_BODY_LENGTH })
    if (!body) continue
    return { preview: body.slice(0, 500), body }
  }
  return null
}
