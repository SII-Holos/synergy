import { z } from "zod"

const Draft = z.object({
  content: z.string().max(8 * 1024 * 1024),
  baseContent: z.string().max(8 * 1024 * 1024),
  expectedVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
})
export type FileDraft = z.infer<typeof Draft>
const Backup = z.object({ version: z.literal(1), drafts: z.record(z.string(), Draft) })
const MAX_CHARACTERS = 16 * 1024 * 1024
const MAX_FILES = 128

export function createFileDraftStorage(
  target: { storage?: string; key: string },
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
) {
  const key = target.storage ? `${target.storage}:${target.key}` : target.key
  let previous: string | null | undefined
  let available = true
  const read = (): Record<string, FileDraft> => {
    try {
      previous = storage.getItem(key)
      if (previous === null) return {}
      if (previous.length > MAX_CHARACTERS) throw new Error("Draft backup exceeds its limit")
      const value = Backup.parse(JSON.parse(previous))
      const paths = Object.keys(value.drafts)
      if (paths.length > MAX_FILES) throw new Error("Too many draft backups")
      if (
        paths.some(
          (path) => path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."),
        )
      )
        throw new Error("Invalid draft path")
      return value.drafts
    } catch {
      available = false
      return {}
    }
  }
  const drafts = read()
  return {
    drafts,
    available: () => available,
    write(drafts: Record<string, FileDraft>) {
      try {
        const entries = Object.entries(drafts).filter(([, draft]) => draft.content !== draft.baseContent)
        const next = entries.length ? JSON.stringify({ version: 1, drafts: Object.fromEntries(entries) }) : null
        if (entries.length > MAX_FILES || (next?.length ?? 0) > MAX_CHARACTERS) return false
        const current = storage.getItem(key)
        if (current !== previous) return false
        if (!available) return false
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
