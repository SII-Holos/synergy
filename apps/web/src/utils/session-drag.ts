/**
 * Drag-and-drop contract for session rows.
 *
 * The canonical writer is `setSessionDragData`: the sidebar (and any other
 * session list) populates `application/x-synergy-session` with
 * `{ id, directory, title, updatedAt? }`, which the prompt-input attachment
 * drop handler consumes directly.
 *
 * The Kanban board consumes the same MIME type but needs the scope/session
 * split, so `parseSessionDragPayload` maps the canonical shape to
 * `{ scopeKey, sessionID }` (tolerant of both the canonical fields and the
 * older `{ scopeKey, sessionID }` shape).
 */

export const SESSION_DRAG_MIME = "application/x-synergy-session"

export type SessionDragData = {
  id: string
  directory: string
  title: string
  updatedAt?: number
}

/**
 * Populate a drag event with the canonical session drag payload.
 *
 * Writes the `application/x-synergy-session` JSON contract consumed by the
 * prompt input drop handler, plus a text/plain title fallback, a copy effect,
 * and a minimal drag image.
 */
export function setSessionDragData(event: DragEvent, data: SessionDragData): void {
  if (!event.dataTransfer) return
  const payload = JSON.stringify({
    id: data.id,
    directory: data.directory,
    title: data.title,
    ...(data.updatedAt !== undefined ? { updatedAt: data.updatedAt } : {}),
  })
  event.dataTransfer.effectAllowed = "copy"
  event.dataTransfer.setData(SESSION_DRAG_MIME, payload)
  event.dataTransfer.setData("text/plain", data.title)
  const dragImage = document.createElement("div")
  dragImage.className =
    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-raised-base text-12-medium text-text-base shadow-lg border border-border-base"
  dragImage.style.position = "absolute"
  dragImage.style.top = "-1000px"
  dragImage.textContent = data.title
  document.body.appendChild(dragImage)
  event.dataTransfer.setDragImage(dragImage, 0, 16)
  setTimeout(() => document.body.removeChild(dragImage), 0)
}

export type SessionDragPayload = {
  scopeKey: string
  sessionID: string
}

/** Parse a `application/x-synergy-session` payload into scope/session parts. */
export function parseSessionDragPayload(raw: string): SessionDragPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      scopeKey?: unknown
      sessionID?: unknown
      directory?: unknown
      id?: unknown
    }
    const scopeKey = typeof parsed.scopeKey === "string" ? parsed.scopeKey : parsed.directory
    const sessionID = typeof parsed.sessionID === "string" ? parsed.sessionID : parsed.id
    if (typeof scopeKey === "string" && scopeKey.length > 0 && typeof sessionID === "string" && sessionID.length > 0) {
      return { scopeKey, sessionID }
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
