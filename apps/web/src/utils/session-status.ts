/**
 * Presentation-level session activity shared by every surface that renders a
 * session's runtime state. Each surface keeps its own glyph, tone, and copy;
 * only this classification is shared, so the surfaces cannot disagree about
 * what a status means.
 *
 * `waiting` is decided by the caller from pending permissions and questions,
 * and outranks every runtime status because a blocked session is what the user
 * must act on. `recovering` stays distinct from ordinary work because the
 * status bar presents it as an intervention rather than progress, while
 * `isWorkingStatus` still counts it as work so tint and spinner agree.
 */
export type SessionActivity = "idle" | "working" | "waiting" | "recovering"

/**
 * The classification reads only the status discriminant, so it accepts any
 * carrier of one: the SDK `SessionStatus` union, a narrowed prop, or a Kanban
 * pane's status type.
 */
export interface SessionStatusInput {
  type?: string
}

/**
 * Whether a status means the session is actively doing work.
 *
 * A missing status is not working: a session whose status is unknown has no
 * evidence of running, and treating it as working would show a spinner that no
 * event can clear.
 */
export function isWorkingStatus(status: SessionStatusInput | undefined): boolean {
  const type = status?.type
  return type === "busy" || type === "retry" || type === "recovering"
}

export function isRecoveringStatus(status: SessionStatusInput | undefined): boolean {
  return status?.type === "recovering"
}

export function classifySessionActivity(input: { status?: SessionStatusInput; waiting?: boolean }): SessionActivity {
  if (input.waiting) return "waiting"
  if (isRecoveringStatus(input.status)) return "recovering"
  if (isWorkingStatus(input.status)) return "working"
  return "idle"
}
