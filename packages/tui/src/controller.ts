import type {
  DagNode,
  EventReplayResult,
  EventStreamPayload,
  GlobalHealthResponse,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  ScopeBootstrapResponse,
  Session,
  SessionInputResult,
  SessionMessagePage,
  Todo,
} from "@ericsanchezok/synergy-sdk/client"
import { createTuiState, reduceTuiState, type TuiAction, type TuiState } from "./reducer.js"
import { createReconnectBackoff, type ReconnectBackoffOptions } from "./backoff.js"

export type BootstrapSnapshot = {
  data: ScopeBootstrapResponse
  epoch?: string
  seq?: number
}

export type SessionUpdate = {
  title?: string
  pinned?: number
  archived?: number
}

export type MessagePageResult = SessionMessagePage & {
  reset?: true
}

export interface RuntimeAdapter {
  health(): Promise<GlobalHealthResponse>
  bootstrap(): Promise<BootstrapSnapshot>
  listInteractions(): Promise<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }>
  subscribe(signal: AbortSignal, lifecycle?: { onDisconnect(): void }): Promise<AsyncIterable<EventStreamPayload>>
  replay(since: number, epoch?: string): Promise<EventReplayResult>
  messagePage(sessionID: string, cursor?: string): Promise<MessagePageResult>
  sessionResources(sessionID: string): Promise<{ todos: Todo[]; dag: DagNode[] }>
  getSession(sessionID: string): Promise<Session>
  createSession(title?: string): Promise<Session>
  updateSession(sessionID: string, patch: SessionUpdate): Promise<Session>
  deleteSession(sessionID: string): Promise<void>
  sendInput(sessionID: string, text: string): Promise<SessionInputResult>
  sendCommand(sessionID: string, command: string, args?: string): Promise<void>
  abortSession(sessionID: string): Promise<void>
  replyPermission(requestID: string, reply: "once" | "session" | "always" | "reject", message?: string): Promise<void>
  replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void>
  rejectQuestion(requestID: string): Promise<void>
}

export type TuiControllerOptions = {
  sessionID?: string
  messagePageSize?: number
  reconnectBackoff?: ReconnectBackoffOptions
  sleep?: (delay: number, signal: AbortSignal) => Promise<void>
}

export type TuiController = {
  getState(): TuiState
  subscribe(listener: (state: TuiState) => void): () => void
  start(): Promise<void>
  stop(): void
  selectSession(sessionID: string): Promise<void>
  loadOlder(): Promise<void>
  createSession(title?: string): Promise<Session>
  renameSession(sessionID: string, title: string): Promise<void>
  togglePin(sessionID: string): Promise<void>
  archiveSession(sessionID: string): Promise<void>
  deleteSession(sessionID: string): Promise<void>
  sendInput(text: string): Promise<SessionInputResult>
  sendCommand(command: string, args?: string): Promise<void>
  abort(): Promise<void>
  replyPermission(requestID: string, reply: "once" | "session" | "always" | "reject", message?: string): Promise<void>
  replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void>
  rejectQuestion(requestID: string): Promise<void>
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function sleepWithSignal(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, delay)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export function createTuiController(adapter: RuntimeAdapter, options: TuiControllerOptions = {}): TuiController {
  let state = createTuiState()
  const listeners = new Set<(state: TuiState) => void>()
  let abortController: AbortController | undefined
  let streamAbortController: AbortController | undefined
  let started = false
  let snapshotReady = false
  let reconnectPending = false
  let startupBuffer: EventStreamPayload[] = []
  let recoveryTask: Promise<void> | undefined
  let loadRevision = 0
  const reconnectBackoff = createReconnectBackoff(options.reconnectBackoff)
  const sleep = options.sleep ?? sleepWithSignal

  const dispatch = (action: TuiAction) => {
    const next = reduceTuiState(state, action)
    if (next === state) return
    state = next
    for (const listener of listeners) listener(state)
  }

  const activeSession = () => {
    const sessionID = state.activeSessionID
    if (!sessionID) throw new Error("No active session")
    return sessionID
  }

  const loadSession = async (sessionID: string, mode: "replace" | "prepend", cursor?: string) => {
    const revision = ++loadRevision
    const [page, resources] = await Promise.all([
      adapter.messagePage(sessionID, cursor),
      mode === "replace" ? adapter.sessionResources(sessionID) : undefined,
    ])
    if (revision !== loadRevision || state.activeSessionID !== sessionID) return
    dispatch({ type: "message-page", sessionID, page, mode: page.reset ? "replace" : mode })
    if (resources) dispatch({ type: "session-resources", sessionID, ...resources })
  }

  const loadActiveSession = async () => {
    if (!state.activeSessionID) return
    await loadSession(state.activeSessionID, "replace")
  }

  const applyBootstrap = async (snapshot: BootstrapSnapshot) => {
    const data = snapshot.data
    dispatch({
      type: "bootstrap",
      payload: {
        scopeID: data.scopeID,
        sessions: data.sessions?.data ?? [],
        sessionStatus: data.sessionStatus,
        command: data.command ?? [],
        agent: data.agent,
        cortex: data.cortex ?? [],
        epoch: snapshot.epoch,
        seq: snapshot.seq,
      },
    })
    if (options.sessionID) {
      const selected = state.sessions.find((session) => session.id === options.sessionID)
      if (selected) dispatch({ type: "select-session", sessionID: selected.id })
      else {
        const session = await adapter.getSession(options.sessionID)
        dispatch({ type: "session-snapshot", session })
        dispatch({ type: "select-session", sessionID: session.id })
      }
    }
    const interactions = await adapter.listInteractions()
    dispatch({ type: "interaction-snapshot", ...interactions })
  }

  const rebootstrap = async () => {
    const snapshot = await adapter.bootstrap()
    await applyBootstrap(snapshot)
    await loadActiveSession()
  }

  const recover = async () => {
    if (recoveryTask) return recoveryTask
    recoveryTask = (async () => {
      dispatch({ type: "connection", status: "recovering" })
      try {
        const { seq, epoch, needsBootstrap } = state.sync
        if (needsBootstrap || seq === undefined) {
          await rebootstrap()
        } else {
          const result = await adapter.replay(state.sync.replayFrom ?? seq, epoch)
          dispatch({ type: "replay", result })
          if (state.sync.needsBootstrap) await rebootstrap()
        }
        dispatch({ type: "connection", status: "live" })
      } catch (error) {
        dispatch({ type: "connection", status: "offline", error: errorMessage(error) })
        throw error
      } finally {
        recoveryTask = undefined
      }
    })()
    return recoveryTask
  }

  const handleEvent = async (event: EventStreamPayload) => {
    dispatch({ type: "event", event })
    if (state.sync.needsBootstrap || state.sync.needsReplay) await recover()
  }

  const streamLifecycle = {
    onDisconnect() {
      streamAbortController?.abort()
      reconnectPending = true
      dispatch({ type: "connection", status: "recovering" })
    },
  }

  const subscribeStream = async (signal: AbortSignal) => {
    streamAbortController?.abort()
    streamAbortController = new AbortController()
    const streamSignal = AbortSignal.any([signal, streamAbortController.signal])
    return adapter.subscribe(streamSignal, streamLifecycle)
  }

  const consume = async (initialStream: AsyncIterable<EventStreamPayload>, signal: AbortSignal) => {
    let stream = initialStream
    while (!signal.aborted) {
      try {
        for await (const event of stream) {
          if (signal.aborted) return
          if (!snapshotReady) {
            startupBuffer.push(event)
            continue
          }
          if (reconnectPending) {
            await recover()
            reconnectPending = false
            reconnectBackoff.reset()
          }
          await handleEvent(event)
        }
        if (signal.aborted) return
      } catch (error) {
        if (signal.aborted) return
        dispatch({ type: "connection", status: "offline", error: errorMessage(error) })
      }

      streamAbortController?.abort()
      let connected = false
      while (!connected && !signal.aborted) {
        dispatch({ type: "connection", status: "recovering" })
        await sleep(reconnectBackoff.next(), signal)
        if (signal.aborted) return
        try {
          const nextStream = await subscribeStream(signal)
          await recover()
          stream = nextStream
          reconnectPending = false
          reconnectBackoff.reset()
          connected = true
        } catch (error) {
          if (signal.aborted) return
          streamAbortController?.abort()
          dispatch({ type: "connection", status: "offline", error: errorMessage(error) })
        }
      }
    }
  }

  const start = async () => {
    if (started) return
    started = true
    abortController = new AbortController()
    snapshotReady = false
    reconnectPending = false
    reconnectBackoff.reset()
    startupBuffer = []
    dispatch({ type: "connection", status: "connecting" })
    try {
      const stream = await subscribeStream(abortController.signal)
      void consume(stream, abortController.signal)
      const [health, snapshot] = await Promise.all([adapter.health(), adapter.bootstrap()])
      if (!health.healthy) throw new Error("Synergy runtime is unhealthy")
      await applyBootstrap(snapshot)
      snapshotReady = true
      for (const event of startupBuffer) await handleEvent(event)
      startupBuffer = []
      await loadActiveSession()
      dispatch({ type: "connection", status: "live" })
    } catch (error) {
      started = false
      abortController.abort()
      dispatch({ type: "connection", status: "offline", error: errorMessage(error) })
      throw error
    }
  }

  const stop = () => {
    started = false
    snapshotReady = false
    reconnectPending = false
    reconnectBackoff.reset()
    startupBuffer = []
    loadRevision++
    streamAbortController?.abort()
    streamAbortController = undefined
    abortController?.abort()
    dispatch({ type: "connection", status: "offline" })
  }

  const selectSession = async (sessionID: string) => {
    if (!state.sessions.some((session) => session.id === sessionID)) {
      dispatch({ type: "session-snapshot", session: await adapter.getSession(sessionID) })
    }
    dispatch({ type: "select-session", sessionID })
    await loadSession(sessionID, "replace")
  }

  const loadOlder = async () => {
    const sessionID = activeSession()
    const cursor = state.conversations[sessionID]?.nextCursor
    if (!cursor) return
    await loadSession(sessionID, "prepend", cursor)
  }

  const createSession = async (title?: string) => {
    const session = await adapter.createSession(title?.trim() || undefined)
    dispatch({ type: "session-snapshot", session })
    dispatch({ type: "select-session", sessionID: session.id })
    await loadSession(session.id, "replace")
    return session
  }

  const renameSession = async (sessionID: string, title: string) => {
    const normalized = title.trim()
    if (!normalized) throw new Error("Session title must not be blank")
    dispatch({ type: "session-snapshot", session: await adapter.updateSession(sessionID, { title: normalized }) })
  }

  const togglePin = async (sessionID: string) => {
    const session = state.sessions.find((item) => item.id === sessionID)
    if (!session) throw new Error(`Unknown session: ${sessionID}`)
    dispatch({
      type: "session-snapshot",
      session: await adapter.updateSession(sessionID, { pinned: session.pinned ? 0 : Date.now() }),
    })
  }

  const archiveSession = async (sessionID: string) => {
    await adapter.updateSession(sessionID, { archived: Date.now() })
    dispatch({ type: "session-removed", sessionID })
  }

  const deleteSession = async (sessionID: string) => {
    await adapter.deleteSession(sessionID)
    dispatch({ type: "session-removed", sessionID })
  }

  const sendInput = async (text: string) => {
    const normalized = text.trim()
    if (!normalized) throw new Error("Message must not be blank")
    return adapter.sendInput(activeSession(), normalized)
  }

  const sendCommand = async (command: string, args?: string) => {
    const normalized = command.trim().replace(/^\//, "")
    if (!normalized) throw new Error("Command must not be blank")
    await adapter.sendCommand(activeSession(), normalized, args?.trim() || undefined)
  }

  const abort = async () => adapter.abortSession(activeSession())

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    stop,
    selectSession,
    loadOlder,
    createSession,
    renameSession,
    togglePin,
    archiveSession,
    deleteSession,
    sendInput,
    sendCommand,
    abort,
    replyPermission: (requestID, reply, message) => adapter.replyPermission(requestID, reply, message),
    replyQuestion: (requestID, answers) => adapter.replyQuestion(requestID, answers),
    rejectQuestion: (requestID) => adapter.rejectQuestion(requestID),
  }
}
