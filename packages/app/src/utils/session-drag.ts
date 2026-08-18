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
  event.dataTransfer.setData("application/x-synergy-session", payload)
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
