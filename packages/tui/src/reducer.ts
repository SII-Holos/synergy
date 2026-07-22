import type {
  Agent,
  Command,
  CortexTask,
  DagNode,
  Event,
  EventMessagePartDelta,
  EventReplayResult,
  EventStreamPayload,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionMessagePage,
  SessionStatus,
  Todo,
} from "@ericsanchezok/synergy-sdk/client"

export type ConversationState = {
  messageOrder: string[]
  messageRevisions: Record<string, number>
  messages: Record<string, Message>
  partsByMessage: Record<string, string[]>
  parts: Record<string, Part>
  nextCursor: string | null
  hasMore: boolean
  total: number
}

export type SyncState = {
  epoch?: string
  seq?: number
  needsReplay?: boolean
  replayFrom?: number
  needsBootstrap: boolean
}

export type ConnectionState = "connecting" | "live" | "recovering" | "offline"

export type TuiState = {
  scopeID?: string
  sessions: Session[]
  activeSessionID?: string
  sessionStatus: Record<string, SessionStatus>
  conversations: Record<string, ConversationState>
  todos: Record<string, Todo[]>
  dag: Record<string, DagNode[]>
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>
  commands: Command[]
  agents: Agent[]
  cortex: CortexTask[]
  connection: ConnectionState
  error?: string
  sync: SyncState
}

export type BootstrapPayload = {
  scopeID: string
  sessions: Session[]
  sessionStatus?: Record<string, SessionStatus>
  command: Command[]
  agent: Agent[]
  cortex: CortexTask[]
  epoch?: string
  seq?: number
}

export type TuiAction =
  | { type: "bootstrap"; payload: BootstrapPayload }
  | { type: "select-session"; sessionID: string }
  | { type: "message-page"; sessionID: string; page: SessionMessagePage; mode: "replace" | "prepend" }
  | { type: "event"; event: EventStreamPayload }
  | { type: "connection"; status: ConnectionState; error?: string }
  | { type: "interaction-snapshot"; permissions: PermissionRequest[]; questions: QuestionRequest[] }
  | { type: "session-snapshot"; session: Session }
  | { type: "session-removed"; sessionID: string }
  | { type: "session-resources"; sessionID: string; todos: Todo[]; dag: DagNode[] }
  | { type: "replay"; result: EventReplayResult }

export function createConversationState(): ConversationState {
  return {
    messageOrder: [],
    messageRevisions: {},
    messages: {},
    partsByMessage: {},
    parts: {},
    nextCursor: null,
    hasMore: false,
    total: 0,
  }
}

export function createTuiState(): TuiState {
  return {
    sessions: [],
    sessionStatus: {},
    conversations: {},
    todos: {},
    dag: {},
    permissions: {},
    questions: {},
    commands: [],
    agents: [],
    connection: "offline",
    cortex: [],
    sync: { needsBootstrap: false },
  }
}

function sortSessions(sessions: Session[]) {
  return sessions
    .slice()
    .sort((left, right) => right.time.updated - left.time.updated || left.id.localeCompare(right.id))
}

function upsertSession(sessions: Session[], session: Session) {
  const index = sessions.findIndex((item) => item.id === session.id)
  const next = sessions.slice()
  if (session.time.archived) {
    if (index >= 0) next.splice(index, 1)
    return sortSessions(next)
  }
  if (index >= 0) next[index] = session
  else next.push(session)
  return sortSessions(next)
}

function conversationFor(state: TuiState, sessionID: string) {
  return state.conversations[sessionID] ?? createConversationState()
}

function bumpMessageRevision(messageRevisions: Record<string, number>, messageID: string) {
  return { ...messageRevisions, [messageID]: (messageRevisions[messageID] ?? 0) + 1 }
}

function sortMessageOrder(conversation: ConversationState) {
  const messageOrder = conversation.messageOrder.slice().sort((leftID, rightID) => {
    const left = conversation.messages[leftID]
    const right = conversation.messages[rightID]
    if (!left || !right) return leftID.localeCompare(rightID)
    return left.time.created - right.time.created || left.id.localeCompare(right.id)
  })
  return { ...conversation, messageOrder }
}

function upsertMessage(conversation: ConversationState, info: Message, sort = true) {
  const existed = conversation.messages[info.id] !== undefined
  const next = {
    ...conversation,
    messages: { ...conversation.messages, [info.id]: info },
    messageOrder: existed ? conversation.messageOrder : [...conversation.messageOrder, info.id],
    messageRevisions: bumpMessageRevision(conversation.messageRevisions, info.id),
  }
  return sort ? sortMessageOrder(next) : next
}

function upsertPart(conversation: ConversationState, part: Part) {
  const previous = conversation.parts[part.id]
  const parts = { ...conversation.parts, [part.id]: part }
  let order = conversation.partsByMessage[part.messageID] ?? []
  if (!previous || previous.messageID !== part.messageID) order = [...order, part.id]
  const partsByMessage = { ...conversation.partsByMessage, [part.messageID]: order }
  let messageRevisions = bumpMessageRevision(conversation.messageRevisions, part.messageID)
  if (previous && previous.messageID !== part.messageID) {
    partsByMessage[previous.messageID] = (partsByMessage[previous.messageID] ?? []).filter((id) => id !== part.id)
    messageRevisions = bumpMessageRevision(messageRevisions, previous.messageID)
  }
  return { ...conversation, parts, partsByMessage, messageRevisions }
}

function removeMessage(conversation: ConversationState, messageID: string) {
  if (!conversation.messages[messageID] && !conversation.partsByMessage[messageID]) return conversation
  const messages = { ...conversation.messages }
  delete messages[messageID]
  const parts = { ...conversation.parts }
  for (const partID of conversation.partsByMessage[messageID] ?? []) delete parts[partID]
  const partsByMessage = { ...conversation.partsByMessage }
  delete partsByMessage[messageID]
  const messageRevisions = { ...conversation.messageRevisions }
  delete messageRevisions[messageID]
  return {
    ...conversation,
    messages,
    parts,
    partsByMessage,
    messageRevisions,
    messageOrder: conversation.messageOrder.filter((id) => id !== messageID),
  }
}

function removePart(conversation: ConversationState, messageID: string, partID: string) {
  if (!conversation.parts[partID]) return conversation
  const parts = { ...conversation.parts }
  delete parts[partID]
  return {
    ...conversation,
    parts,
    partsByMessage: {
      ...conversation.partsByMessage,
      [messageID]: (conversation.partsByMessage[messageID] ?? []).filter((id) => id !== partID),
    },
    messageRevisions: bumpMessageRevision(conversation.messageRevisions, messageID),
  }
}

function applyMessagePage(state: TuiState, action: Extract<TuiAction, { type: "message-page" }>) {
  let conversation = action.mode === "replace" ? createConversationState() : conversationFor(state, action.sessionID)
  for (const item of action.page.items) {
    conversation = upsertMessage(conversation, item.info, false)
    const retained = new Set(item.parts.map((part) => part.id))
    for (const partID of conversation.partsByMessage[item.info.id] ?? []) {
      if (!retained.has(partID)) conversation = removePart(conversation, item.info.id, partID)
    }
    for (const part of item.parts) conversation = upsertPart(conversation, part)
  }
  conversation = sortMessageOrder(conversation)
  conversation = {
    ...conversation,
    nextCursor: action.page.nextCursor,
    hasMore: action.page.hasMore,
    total: action.page.total,
  }
  return { ...state, conversations: { ...state.conversations, [action.sessionID]: conversation } }
}

function appendDelta(state: TuiState, event: EventMessagePartDelta) {
  const { sessionID, messageID, partID, kind, delta } = event.properties
  const conversation = state.conversations[sessionID]
  const part = conversation?.parts[partID]
  if (!conversation || !part || part.messageID !== messageID || part.type !== kind) return state
  const nextPart = { ...part, text: part.text + delta } as Part
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [sessionID]: upsertPart(conversation, nextPart),
    },
  }
}

function removeInteraction<T extends { id: string }>(items: Record<string, T[]>, sessionID: string, requestID: string) {
  return { ...items, [sessionID]: (items[sessionID] ?? []).filter((item) => item.id !== requestID) }
}

function applyDomainEvent(state: TuiState, event: Event): TuiState {
  switch (event.type) {
    case "session.updated": {
      const sessions = upsertSession(state.sessions, event.properties.info)
      const activeSessionID = state.activeSessionID ?? sessions[0]?.id
      return { ...state, sessions, activeSessionID }
    }
    case "session.deleted": {
      const sessionID = event.properties.info.id
      const sessions = state.sessions.filter((item) => item.id !== sessionID)
      const conversations = { ...state.conversations }
      delete conversations[sessionID]
      const activeSessionID = state.activeSessionID === sessionID ? sessions[0]?.id : state.activeSessionID
      return { ...state, sessions, conversations, activeSessionID }
    }
    case "session.status":
      return {
        ...state,
        sessionStatus: { ...state.sessionStatus, [event.properties.sessionID]: event.properties.status },
      }
    case "message.updated": {
      const info = event.properties.info
      const conversation = upsertMessage(conversationFor(state, info.sessionID), info)
      return { ...state, conversations: { ...state.conversations, [info.sessionID]: conversation } }
    }
    case "message.removed": {
      const { sessionID, messageID } = event.properties
      const conversation = removeMessage(conversationFor(state, sessionID), messageID)
      return { ...state, conversations: { ...state.conversations, [sessionID]: conversation } }
    }
    case "message.part.updated": {
      const part = event.properties.part
      const conversation = upsertPart(conversationFor(state, part.sessionID), part)
      return { ...state, conversations: { ...state.conversations, [part.sessionID]: conversation } }
    }
    case "message.part.removed": {
      const { sessionID, messageID, partID } = event.properties
      const conversation = removePart(conversationFor(state, sessionID), messageID, partID)
      return { ...state, conversations: { ...state.conversations, [sessionID]: conversation } }
    }
    case "todo.updated":
      return { ...state, todos: { ...state.todos, [event.properties.sessionID]: event.properties.todos } }
    case "dag.updated":
      return { ...state, dag: { ...state.dag, [event.properties.sessionID]: event.properties.nodes } }
    case "permission.asked": {
      const request = event.properties
      const current = state.permissions[request.sessionID] ?? []
      const next = [...current.filter((item) => item.id !== request.id), request]
      return { ...state, permissions: { ...state.permissions, [request.sessionID]: next } }
    }
    case "permission.replied":
      return {
        ...state,
        permissions: removeInteraction(state.permissions, event.properties.sessionID, event.properties.requestID),
      }
    case "question.asked": {
      const request = event.properties
      const current = state.questions[request.sessionID] ?? []
      const next = [...current.filter((item) => item.id !== request.id), request]
      return { ...state, questions: { ...state.questions, [request.sessionID]: next } }
    }
    case "question.replied":
    case "question.rejected":
    case "question.timed_out":
      return {
        ...state,
        questions: removeInteraction(state.questions, event.properties.sessionID, event.properties.requestID),
      }
    case "cortex.task.created":
    case "cortex.task.completed": {
      const task = event.properties.task
      return { ...state, cortex: [...state.cortex.filter((item) => item.id !== task.id), task] }
    }
    case "cortex.tasks.updated":
      return { ...state, cortex: event.properties.tasks }
    default:
      return state
  }
}

function applyLiveEvent(state: TuiState, event: EventStreamPayload): TuiState {
  if (event.type === "message.part.delta") return appendDelta(state, event)

  if (event.seq !== undefined && event.epoch !== undefined) {
    if (state.sync.epoch !== undefined && event.epoch !== state.sync.epoch) {
      return { ...state, sync: { ...state.sync, needsBootstrap: true, needsReplay: false, replayFrom: undefined } }
    }
    if (state.sync.seq !== undefined) {
      if (event.seq <= state.sync.seq) return state
      if (event.seq > state.sync.seq + 1) {
        return {
          ...state,
          sync: { ...state.sync, needsReplay: true, replayFrom: state.sync.seq, needsBootstrap: false },
        }
      }
    }
    const applied = applyDomainEvent(state, event)
    return {
      ...applied,
      sync: { epoch: event.epoch, seq: event.seq, needsBootstrap: false },
    }
  }
  return applyDomainEvent(state, event)
}

function applyReplay(state: TuiState, result: EventReplayResult): TuiState {
  if (result.status === "reset" || (state.sync.epoch !== undefined && result.epoch !== state.sync.epoch)) {
    return {
      ...state,
      sync: { epoch: result.epoch, seq: result.seq, needsBootstrap: true, needsReplay: false, replayFrom: undefined },
    }
  }

  let next = state
  for (const event of result.events.slice().sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))) {
    next = applyLiveEvent(next, event)
    if (next.sync.needsBootstrap || next.sync.needsReplay) return next
  }
  return { ...next, sync: { epoch: result.epoch, seq: result.seq, needsBootstrap: false } }
}

function groupBySession<T extends { sessionID: string }>(items: T[]) {
  const grouped: Record<string, T[]> = {}
  for (const item of items) (grouped[item.sessionID] ??= []).push(item)
  return grouped
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "bootstrap": {
      const sessions = sortSessions(action.payload.sessions.filter((session) => !session.time.archived))
      const activeSessionID =
        state.activeSessionID && sessions.some((session) => session.id === state.activeSessionID)
          ? state.activeSessionID
          : sessions[0]?.id
      return {
        ...state,
        scopeID: action.payload.scopeID,
        sessions,
        activeSessionID,
        sessionStatus: action.payload.sessionStatus ?? {},
        commands: action.payload.command,
        agents: action.payload.agent,
        cortex: action.payload.cortex,
        sync: {
          ...(action.payload.epoch === undefined ? {} : { epoch: action.payload.epoch }),
          ...(action.payload.seq === undefined ? {} : { seq: action.payload.seq }),
          needsBootstrap: false,
        },
      }
    }
    case "connection":
      return {
        ...state,
        connection: action.status,
        ...(action.error === undefined ? { error: undefined } : { error: action.error }),
      }
    case "interaction-snapshot":
      return {
        ...state,
        permissions: groupBySession(action.permissions),
        questions: groupBySession(action.questions),
      }
    case "session-snapshot": {
      const sessions = upsertSession(state.sessions, action.session)
      return { ...state, sessions, activeSessionID: state.activeSessionID ?? action.session.id }
    }
    case "session-removed": {
      const sessions = state.sessions.filter((session) => session.id !== action.sessionID)
      const conversations = { ...state.conversations }
      delete conversations[action.sessionID]
      return {
        ...state,
        sessions,
        conversations,
        activeSessionID: state.activeSessionID === action.sessionID ? sessions[0]?.id : state.activeSessionID,
      }
    }
    case "session-resources":
      return {
        ...state,
        todos: { ...state.todos, [action.sessionID]: action.todos },
        dag: { ...state.dag, [action.sessionID]: action.dag },
      }
    case "select-session":
      return { ...state, activeSessionID: action.sessionID }
    case "message-page":
      return applyMessagePage(state, action)
    case "event":
      return applyLiveEvent(state, action.event)
    case "replay":
      return applyReplay(state, action.result)
  }
}
