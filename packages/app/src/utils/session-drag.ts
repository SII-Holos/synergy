import { HOME_SCOPE_KEY } from "@/utils/scope"

/**
 * Resolve the directory token carried by a session drag payload.
 *
 * Home-scope sessions have no real directory; the drop side requires a
 * non-empty directory to accept the reference, so home sessions carry the
 * reserved HOME_SCOPE_KEY ("home") token instead of omitting the field.
 */
export function sessionDragDirectory(scope: {
  type?: string
  id: string
  directory?: string
  worktree?: string
}): string {
  if (scope.type === "home" || scope.id === HOME_SCOPE_KEY) return HOME_SCOPE_KEY
  return scope.directory ?? scope.worktree ?? scope.id
}

export type SessionDragData = {
  id: string
  directory: string
  title: string
  updatedAt?: number
}

/**
 * Populate a drag event with the canonical session drag payload.
 *
 * Mirrors the payload shape established by the scopes session rows: the
 * `application/x-synergy-session` JSON contract plus a text/plain title
 * fallback, a copy effect, and a minimal drag image.
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
