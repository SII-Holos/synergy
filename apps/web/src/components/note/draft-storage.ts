import { migrateNoteDocumentDraft } from "./document-controller"

export function createNoteDraftStorage(
  target: { storage?: string; key: string },
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
) {
  const key = target.storage ? `${target.storage}:${target.key}` : target.key
  let previous: string | null = null
  let available = true
  let draft: unknown = null
  try {
    previous = storage.getItem(key)
    if (previous !== null) {
      if (previous.length > 8 * 1024 * 1024) throw new Error("Note backup exceeds its limit")
      const value: unknown = JSON.parse(previous)
      draft = migrateNoteDocumentDraft(value && typeof value === "object" && "draft" in value ? value.draft : null)
      if (!draft) throw new Error("Invalid note backup")
    }
  } catch {
    available = false
  }
  return {
    draft,
    available,
    write(draft: unknown) {
      if (!available) return false
      try {
        const next = draft ? JSON.stringify({ draft }) : null
        if ((next?.length ?? 0) > 8 * 1024 * 1024 || storage.getItem(key) !== previous) return false
        if (next === previous) return true
        if (next === null) storage.removeItem(key)
        else storage.setItem(key, next)
        previous = next
        return true
      } catch {
        return false
      }
    },
  }
}
