import { createSignal, type Accessor } from "solid-js"

export const ATTACHMENT_UPLOAD_FLASH_MS = 1600

/**
 * Composer-local pending attachment state. An entry exists from the moment a
 * file is selected until its upload settles; it is deliberately not part of
 * the persisted prompt draft, so a reload mid-upload drops the card instead
 * of persisting an unusable placeholder. A settled upload inserts the real
 * prompt part with the same id first, then flashes "uploaded" briefly before
 * the normal attachment card takes over.
 */
export interface PendingPromptAttachment {
  id: string
  filename: string
  mime: string
  size: number
  status: "uploading" | "uploaded" | "failed"
  error?: string
}

export interface PendingAttachmentTracker {
  pending: Accessor<PendingPromptAttachment[]>
  /** True while any entry is still in flight; a flashing entry does not block sending. */
  uploading: Accessor<boolean>
  blocking: Accessor<boolean>
  file(id: string): File | undefined
  begin(entry: Omit<PendingPromptAttachment, "status" | "error">, file?: File): void
  markFailed(id: string, error?: string): void
  markUploaded(id: string): void
  end(id: string): void
  cancel(id: string): boolean
  isCancelled(id: string): boolean
  /** Invalidates in-flight entries and clears presentation on session switch. */
  clear(): void
  /** In-flight count and bytes, merged into the composer batch limits. */
  scope(): { count: number; bytes: number }
}

export function createPendingAttachmentTracker(options?: { flashMs?: number }): PendingAttachmentTracker {
  const flashMs = options?.flashMs ?? ATTACHMENT_UPLOAD_FLASH_MS
  const [pending, setPending] = createSignal<PendingPromptAttachment[]>([])
  const cancelled = new Set<string>()
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const files = new Map<string, File>()

  const clearFlash = (id: string) => {
    const timer = flashTimers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    flashTimers.delete(id)
  }

  return {
    pending,
    uploading: () => pending().some((entry) => entry.status === "uploading"),
    blocking: () => pending().some((entry) => entry.status !== "uploaded"),
    file: (id) => files.get(id),
    begin(entry, file) {
      clearFlash(entry.id)
      cancelled.delete(entry.id)
      if (file) files.set(entry.id, file)
      setPending((list) =>
        list.some((item) => item.id === entry.id)
          ? list.map((item) => (item.id === entry.id ? { ...entry, status: "uploading" } : item))
          : [...list, { ...entry, status: "uploading" }],
      )
    },
    markFailed(id, error) {
      if (cancelled.has(id)) return
      setPending((list) => list.map((entry) => (entry.id === id ? { ...entry, status: "failed", error } : entry)))
    },
    markUploaded(id) {
      if (!pending().some((entry) => entry.id === id && entry.status === "uploading")) return
      clearFlash(id)
      files.delete(id)
      setPending((list) => list.map((entry) => (entry.id === id ? { ...entry, status: "uploaded" } : entry)))
      flashTimers.set(
        id,
        setTimeout(() => {
          flashTimers.delete(id)
          setPending((list) => list.filter((entry) => entry.id !== id))
        }, flashMs),
      )
    },
    end(id) {
      clearFlash(id)
      cancelled.delete(id)
      files.delete(id)
      setPending((list) => list.filter((entry) => entry.id !== id))
    },
    cancel(id) {
      if (!pending().some((entry) => entry.id === id)) return false
      clearFlash(id)
      files.delete(id)
      if (pending().some((entry) => entry.id === id && entry.status === "uploading")) cancelled.add(id)
      setPending((list) => list.filter((entry) => entry.id !== id))
      return true
    },
    isCancelled(id) {
      return cancelled.has(id)
    },
    clear() {
      for (const entry of pending()) if (entry.status === "uploading") cancelled.add(entry.id)
      for (const timer of flashTimers.values()) clearTimeout(timer)
      flashTimers.clear()
      files.clear()
      setPending([])
    },
    scope() {
      const entries = pending().filter((entry) => entry.status !== "uploaded")
      return {
        count: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.size, 0),
      }
    },
  }
}
