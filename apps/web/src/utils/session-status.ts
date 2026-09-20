import type { SessionStatus, SessionWorkingInfo } from "@ericsanchezok/synergy-sdk/client"

/**
 * Presentation-level session activity shared by every surface that renders a
 * session's runtime state. Each surface keeps its own glyph, tone, and copy;
 * only this classification is shared, so the surfaces cannot disagree about
 * what a status means.
 *
 * `waiting` is decided by the caller from pending permissions and questions,
 * and outranks every runtime status because a blocked session is what the user
 * must act on. `paused` stays distinct from ordinary work: a paused session is
 * stopped until the user continues, abandons, or sends input, so it carries
 * neither the working tint nor a spinner that no event can clear.
 */
export type SessionActivity = "idle" | "working" | "waiting" | "paused"

/**
 * The classification reads only the fields a surface presents, so it accepts
 * any carrier of them: the SDK `SessionStatus` union, a persisted `working`
 * projection, a narrowed prop, or a Kanban pane's status type.
 */
export interface SessionStatusInput {
  type?: string
  description?: string
  attempt?: number
  message?: string
  reason?: string
  since?: number
}

export type PausedSessionStatus = Extract<SessionStatus, { type: "paused" }>

/**
 * Whether a status means the session is actively doing work.
 *
 * `paused` is deliberately not working: the session is stopped, and counting it
 * as work would restore the spinner that no event can clear. A missing status
 * is likewise not working — a session whose status is unknown has no evidence
 * of running.
 */
export function isWorkingStatus(status: SessionStatusInput | undefined): boolean {
  const type = status?.type
  return type === "busy" || type === "retry"
}

export function isPausedStatus(status: SessionStatusInput | undefined): boolean {
  return status?.type === "paused"
}

export function isPausedSessionStatus(status: SessionStatus | undefined): status is PausedSessionStatus {
  return status?.type === "paused"
}

export function isRetryStatus(status: SessionStatusInput | undefined): boolean {
  return status?.type === "retry"
}

export function classifySessionActivity(input: { status?: SessionStatusInput; waiting?: boolean }): SessionActivity {
  if (input.waiting) return "waiting"
  if (isPausedStatus(input.status)) return "paused"
  if (isWorkingStatus(input.status)) return "working"
  return "idle"
}

/** Project a persisted `working` payload onto the published status union. */
export function sessionStatusFromWorking(working: SessionWorkingInfo): SessionStatus {
  switch (working.status) {
    case "busy":
      return { type: "busy", description: working.description }
    case "retry":
      return { type: "retry", attempt: working.attempt, message: working.message, next: working.next }
    case "paused":
      return {
        type: "paused",
        reason: working.reason,
        ...(working.description ? { description: working.description } : {}),
        since: working.since,
      }
  }
}

/**
 * One resolution for "what is this session doing now": a live runtime status
 * wins, the persisted `working` projection covers a session whose status event
 * predates this client, and anything else is idle.
 */
export function resolveSessionStatus(input: {
  runtimeStatus?: SessionStatus
  working?: SessionWorkingInfo
}): SessionStatus {
  const runtime = input.runtimeStatus
  if (runtime && runtime.type !== "idle") return runtime
  if (input.working) return sessionStatusFromWorking(input.working)
  return runtime ?? { type: "idle" }
}
