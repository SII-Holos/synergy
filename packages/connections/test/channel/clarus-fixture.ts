import type {
  NativeMessage,
  NativeTunnelPort,
  NativeRequestFailure,
  HolosConnectionEvent,
} from "../../src/holos/native"
import type {
  ClarusAgentTunnelPort,
  ClarusObservedEvent,
  ClarusKnownEvent,
  ClarusEventHandler,
  SubscribeProjectInput,
  UnsubscribeProjectInput,
  ExtendTaskInput,
  RecordTaskResultInput,
  RuntimeTaskAssignedEvent,
} from "../../src/channel/provider/clarus/agent-tunnel-port"

// ---------------------------------------------------------------------------
// FakeNativeTunnelPort – a fully controllable NativeTunnelPort for testing
// ---------------------------------------------------------------------------
export type PendingRequest = {
  type: string
  payload: unknown
  requestID: string
  expectedResponseType: string
  resolve: (msg: NativeMessage) => void
  reject: (err: NativeRequestFailure) => void
}

export class FakeNativeTunnelPort implements NativeTunnelPort {
  private _eventObserver?: (msg: NativeMessage) => void | Promise<void>
  private _connectionObserver?: (event: HolosConnectionEvent) => void | Promise<void>
  private _nextEpoch = 1
  private _nextGeneration = 1
  private _agentID = "test-agent"

  /** All sendNativeRequest calls, preserved for inspection. */
  readonly pending = new Map<string, PendingRequest>()
  readonly settled: PendingRequest[] = []

  setAgentID(id: string) {
    this._agentID = id
  }
  setEpoch(epoch: number) {
    this._nextEpoch = epoch
  }
  setGeneration(generation: number) {
    this._nextGeneration = generation
  }

  registerNativeObserver(handler: (msg: NativeMessage) => void | Promise<void>): () => void {
    this._eventObserver = handler
    return () => {
      if (this._eventObserver === handler) this._eventObserver = undefined
    }
  }

  registerConnectionObserver(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this._connectionObserver = handler
    return () => {
      if (this._connectionObserver === handler) this._connectionObserver = undefined
    }
  }

  sendNativeRequest(input: {
    type: string
    payload: unknown
    requestID: string
    expectedResponseType: string
    timeoutMs?: number
    signal?: AbortSignal
    meta?: Record<string, unknown>
  }): { response: Promise<NativeMessage>; requestID: string } {
    const requestID = input.requestID
    let internalResolve!: (msg: NativeMessage) => void
    let internalReject!: (err: NativeRequestFailure) => void
    const self = this
    const pendingRequest: PendingRequest = {
      type: input.type,
      payload: input.payload,
      requestID,
      expectedResponseType: input.expectedResponseType,
      resolve: (msg) => {
        const idx = self.settled.indexOf(pendingRequest)
        if (idx !== -1) return
        self.pending.delete(requestID)
        self.settled.push(pendingRequest)
        internalResolve(msg)
      },
      reject: (err) => {
        const idx = self.settled.indexOf(pendingRequest)
        if (idx !== -1) return
        self.pending.delete(requestID)
        self.settled.push(pendingRequest)
        internalReject(err)
      },
    }
    this.pending.set(requestID, pendingRequest)

    const response = new Promise<NativeMessage>((resolve, reject) => {
      internalResolve = resolve
      internalReject = reject
    })
    return { response, requestID }
  }

  /** Fulfill a pending request with a native response message. */
  fulfill(requestID: string, overrides: Partial<NativeMessage> = {}) {
    const pending = this.pending.get(requestID)
    if (!pending) throw new Error(`No pending request ${requestID}`)
    pending.resolve(
      makeNativeMessage(this._agentID, this._nextEpoch, this._nextGeneration, {
        type: pending.expectedResponseType,
        requestID,
        payload: {},
        ...overrides,
      }),
    )
  }

  /** Reject a pending request with a ClarusRequestFailure. */
  reject(requestID: string, failure: NativeRequestFailure) {
    const pending = this.pending.get(requestID)
    if (!pending) throw new Error(`No pending request ${requestID}`)
    pending.reject(failure)
  }

  /** Emit an inbound event through the observer. */
  emitEvent(type: string, payload: unknown, overrides: Partial<NativeMessage> = {}) {
    const msg = makeNativeMessage(this._agentID, this._nextEpoch, this._nextGeneration, {
      type,
      payload,
      requestID: null,
      ...overrides,
    })
    this._eventObserver?.(msg)
  }

  /** Emit a connection event. */
  emitConnection(event: HolosConnectionEvent) {
    this._connectionObserver?.(event)
  }

  /** Bump epoch/generation and return them. */
  bumpGeneration(): { epoch: number; generation: number } {
    this._nextEpoch++
    this._nextGeneration++
    return { epoch: this._nextEpoch, generation: this._nextGeneration }
  }
}

function makeNativeMessage(
  agentID: string,
  epoch: number,
  generation: number,
  overrides: Partial<NativeMessage>,
): NativeMessage {
  return {
    type: overrides.type ?? "clarus.unknown",
    requestID: overrides.requestID ?? null,
    meta: overrides.meta ?? {},
    payload: overrides.payload ?? {},
    caller: overrides.caller ?? {},
    agentID: overrides.agentID ?? agentID,
    sessionID: overrides.sessionID ?? null,
    generation: overrides.generation ?? generation,
    epoch: overrides.epoch ?? epoch,
  }
}

// ---------------------------------------------------------------------------
// Event factories – produce ClarusObservedEvent shapes for direct testing
// ---------------------------------------------------------------------------
export function taskAssignedEvent(overrides: Partial<RuntimeTaskAssignedEvent> = {}): RuntimeTaskAssignedEvent {
  return {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: "test-agent",
    requestID: overrides.requestID ?? null,
    projectID: "proj-test",
    runID: "run-1",
    taskID: "task-1",
    phase: "implementation",
    subtaskID: "subtask-1",
    attempt: 1,
    deadlineAt: null,
    goal: "Complete the task",
    epoch: 1,
    generation: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// HolosConnectionEvent factory
// ---------------------------------------------------------------------------
export function disconnectedEvent(
  overrides: Partial<HolosConnectionEvent & { type: "disconnected" }> = {},
): HolosConnectionEvent & { type: "disconnected" } {
  return {
    type: "disconnected",
    agentID: "test-agent",
    sessionID: null,
    generation: 1,
    epoch: 1,
    code: 1000,
    reason: "transport_lost",
    ...overrides,
  }
}

export function nativeMessageSubscribedACk(
  agentID: string,
  projectID: string,
  requestID: string,
  epoch: number,
  generation: number,
): NativeMessage {
  return makeNativeMessage(agentID, epoch, generation, {
    type: "clarus.project.subscribed",
    requestID,
    payload: { project_id: projectID, subscribed: true },
  })
}

export function nativeMessageTaskAssigned(
  agentID: string,
  projectID: string,
  epoch: number,
  generation: number,
  overrides: Partial<NativeMessage> = {},
): NativeMessage {
  return makeNativeMessage(agentID, epoch, generation, {
    type: "clarus.runtime.task.assigned",
    requestID: null,
    payload: {
      run_id: "run-1",
      project_id: projectID,
      task_id: "task-1",
      phase: "implementation",
      subtask_id: "subtask-1",
      attempt: 1,
      deadline_at: null,
      goal: "Complete the task",
    },
    ...overrides,
  })
}
