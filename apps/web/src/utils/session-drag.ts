export const SESSION_DRAG_MIME = "application/x-synergy-session"

export type SessionDragData = {
  id: string
  scopeID: string
  connection: string
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
    scopeID: data.scopeID,
    connection: data.connection,
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
  setTimeout(() => dragImage.remove(), 0)
}

export type SessionDragPayload = {
  scopeKey: string
  sessionID: string
}

export function parseSessionDragData(raw: string, connection: string): SessionDragData | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || !("connection" in parsed) || parsed.connection !== connection) return
    if (!("id" in parsed) || typeof parsed.id !== "string" || !parsed.id) return
    if (!("scopeID" in parsed) || typeof parsed.scopeID !== "string" || !parsed.scopeID) return
    return {
      id: parsed.id,
      scopeID: parsed.scopeID,
      connection,
      title: "title" in parsed && typeof parsed.title === "string" ? parsed.title : "",
      ...("updatedAt" in parsed && typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
        ? { updatedAt: parsed.updatedAt }
        : {}),
    }
  } catch {
    return
  }
}

export function parseSessionDragPayload(raw: string, connection: string): SessionDragPayload | undefined {
  const data = parseSessionDragData(raw, connection)
  return data ? { scopeKey: data.scopeID, sessionID: data.id } : undefined
}

/**
 * Board-internal drag contract for reordering pinned panes. The payload is the
 * pane key (`scopeKey\nsessionID`); the drop target is resolved from the
 * closest `[data-pane-key]` element under the pointer.
 */
export const KANBAN_REORDER_MIME = "application/x-synergy-kanban-reorder"
