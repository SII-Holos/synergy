export function createContentBudget(limit = 128 * 1024 * 1024) {
  const entries = new Map<string, { version: string; bytes: number; evict(): void }>()
  const readers = new Map<string, number>()
  let bytes = 0
  const remove = (key: string, version?: string) => {
    const entry = entries.get(key)
    if (!entry || (version !== undefined && entry.version !== version)) return
    entries.delete(key)
    bytes -= entry.bytes
  }
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= limit) break
      if (readers.has(key)) continue
      remove(key)
      entry.evict()
    }
  }
  return {
    get bytes() {
      return bytes
    },
    retain(key: string) {
      readers.set(key, (readers.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = (readers.get(key) ?? 1) - 1
        if (count) readers.set(key, count)
        else readers.delete(key)
        trim()
      }
    },
    publish(key: string, version: string, size: number, evict: () => void) {
      remove(key)
      entries.set(key, { version, bytes: size, evict })
      bytes += size
      trim()
    },
    remove,
    clearPrefix(prefix: string) {
      for (const key of entries.keys()) if (key.startsWith(prefix)) remove(key)
    },
    dispose() {
      entries.clear()
      readers.clear()
      bytes = 0
    },
  }
}

export const contentBudgetKey = (scopeKey: string, messageID: string, partID = "") =>
  `${scopeKey}\0${messageID}\0${partID}`
export type ContentBudget = ReturnType<typeof createContentBudget>
