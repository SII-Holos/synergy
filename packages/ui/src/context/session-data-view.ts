import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import type {
  CortexTask,
  DagNode,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@ericsanchezok/synergy-sdk"
import type { Data } from "./data"

/**
 * Shared empty arrays returned by the session data view.
 *
 * The render chain's `same()` equality guards (session-turn.tsx) short-circuit
 * on reference identity, so every accessor must return these module-level
 * singletons for missing buckets — never a fresh literal. Each singleton is
 * frozen (`Object.freeze`) so a consumer cannot mutate the shared instance and
 * leak state across sessions; the types stay mutable to keep the accessor
 * contracts (`Part[]`, `Message[]`, …) assignable to existing consumers.
 */
function frozenEmptyArray<T>(): T {
  return Object.freeze([]) as unknown as T
}
export const EMPTY_PARTS: Part[] = frozenEmptyArray<Part[]>()
export const EMPTY_MESSAGES: Message[] = frozenEmptyArray<Message[]>()
export const EMPTY_PERMISSIONS: PermissionRequest[] = frozenEmptyArray<PermissionRequest[]>()
export const EMPTY_INBOX: SessionInboxItem[] = frozenEmptyArray<SessionInboxItem[]>()
export const EMPTY_TODOS: Todo[] = frozenEmptyArray<Todo[]>()
export const EMPTY_DAG: DagNode[] = frozenEmptyArray<DagNode[]>()
export const EMPTY_QUESTIONS: QuestionRequest[] = frozenEmptyArray<QuestionRequest[]>()
export const EMPTY_CORTEX: CortexTask[] = frozenEmptyArray<CortexTask[]>()
export const EMPTY_SESSIONS: Session[] = frozenEmptyArray<Session[]>()
export const EMPTY_PART_TABLE: Record<string, Part[] | undefined> = Object.freeze({}) as unknown as Record<
  string,
  Part[] | undefined
>

/**
 * Null-safe accessors over the shared session store.
 *
 * Session switches race the store's intermediate states: buckets for the next
 * session may be missing, a whole scope store may be released while an old
 * component tree is still unmounting, and `createMemo` default values stop
 * applying once a memo has computed once. Every accessor therefore applies its
 * `?? EMPTY` fallback *inside the function body* on each evaluation, so a
 * render can never observe `undefined` for an array-shaped session field.
 *
 * Accessors are thin closures: reading `data.part[id]` inside a `createMemo`
 * still subscribes to the Solid store path, so reactivity is unchanged.
 */
export interface SessionDataView {
  partsFor(messageID: string): Part[]
  partTable(): Record<string, Part[] | undefined>
  messagesFor(sessionID: string): Message[]
  permissionsFor(sessionID: string): PermissionRequest[]
  statusFor(sessionID: string): SessionStatus | undefined
  inboxFor(sessionID: string): SessionInboxItem[]
  /** Whether the session's inbox bucket exists — missing means "not loaded yet". */
  hasInboxBucket(sessionID: string): boolean
  todosFor(sessionID: string): Todo[]
  dagNodesFor(sessionID: string): DagNode[]
  questionsFor(sessionID: string): QuestionRequest[]
  cortexTasks(): CortexTask[]
  sessions(): Session[]
  sessionFor(sessionID: string): Session | undefined
}

export function createSessionDataView(data: Data | undefined): SessionDataView {
  return {
    partsFor: (messageID) => data?.part?.[messageID] ?? EMPTY_PARTS,
    partTable: () => data?.part ?? EMPTY_PART_TABLE,
    messagesFor: (sessionID) => data?.message?.[sessionID] ?? EMPTY_MESSAGES,
    permissionsFor: (sessionID) => data?.permission?.[sessionID] ?? EMPTY_PERMISSIONS,
    statusFor: (sessionID) => data?.session_status?.[sessionID],
    inboxFor: (sessionID) => data?.inbox?.[sessionID] ?? EMPTY_INBOX,
    hasInboxBucket: (sessionID) => data?.inbox?.[sessionID] !== undefined,
    todosFor: (sessionID) => data?.todo?.[sessionID] ?? EMPTY_TODOS,
    dagNodesFor: (sessionID) => data?.dag?.[sessionID] ?? EMPTY_DAG,
    questionsFor: (sessionID) => data?.question?.[sessionID] ?? EMPTY_QUESTIONS,
    cortexTasks: () => data?.cortex ?? EMPTY_CORTEX,
    // Reads the store at call time like every other accessor: a view created
    // outside a reactive scope (or memoized against a non-reactive property)
    // must not freeze the session list at creation time.
    sessions: () => data?.session ?? EMPTY_SESSIONS,
    sessionFor: (sessionID) => (data?.session ?? EMPTY_SESSIONS).find((session) => session.id === sessionID),
  }
}
