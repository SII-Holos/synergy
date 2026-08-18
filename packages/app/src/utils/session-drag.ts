/**
 * Drag-and-drop contract between the sidebar session rows and the Kanban
 * board: sidebar rows carry a JSON payload under this MIME type; the board
 * parses it and pins the session.
 */

export const SESSION_DRAG_MIME = "application/x-synergy-session"

export type SessionDragPayload = {
  scopeKey: string
  sessionID: string
}

export function encodeSessionDragPayload(payload: SessionDragPayload): string {
  return JSON.stringify(payload)
}

export function parseSessionDragPayload(raw: string): SessionDragPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as { scopeKey?: unknown; sessionID?: unknown }
    if (
      typeof parsed.scopeKey === "string" &&
      typeof parsed.sessionID === "string" &&
      parsed.scopeKey.length > 0 &&
      parsed.sessionID.length > 0
    ) {
      return { scopeKey: parsed.scopeKey, sessionID: parsed.sessionID }
    }
  } catch {
    // Malformed or foreign drag payloads are ignored.
  }
  return undefined
}

/**
 * Board-internal drag contract for reordering pinned panes. The payload is the
 * pane key (`scopeKey\nsessionID`); the drop target is resolved from the
 * closest `[data-pane-key]` element under the pointer.
 */
export const KANBAN_REORDER_MIME = "application/x-synergy-kanban-reorder"
