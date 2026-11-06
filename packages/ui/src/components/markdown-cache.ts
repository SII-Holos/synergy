import type { MarkdownRenderEntry } from "./markdown-render"

export function createMarkdownCache(budget = 16 * 1024 * 1024) {
  const entries = new Map<string, MarkdownRenderEntry>()
  let bytes = 0
  const size = (key: string, entry: MarkdownRenderEntry) =>
    (key.length +
      entry.hash.length +
      entry.html.length +
      (entry.document?.blocks.reduce((bytes, block) => bytes + block.html.length, 0) ?? 0) +
      Object.values(entry.document?.codes ?? {}).reduce((bytes, code) => bytes + code.length, 0)) *
      2 +
    (entry.document?.reading?.marker.length ?? 0) * 2 +
    (entry.document?.reading?.runs.reduce((bytes, run) => bytes + 16 + (run.spans?.length ?? 0) * 32, 0) ?? 0) +
    (entry.layout ? entry.layout.font.length * 2 + 8 + (entry.document?.blocks.length ?? 0) * 16 : 0)
  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    bytes -= size(key, entry)
    entries.delete(key)
  }
  return {
    get bytes() {
      return bytes
    },
    get(key: string) {
      const entry = entries.get(key)
      if (entry) {
        entries.delete(key)
        entries.set(key, entry)
      }
      return entry
    },
    set(key: string, entry: MarkdownRenderEntry) {
      remove(key)
      const added = size(key, entry)
      if (added > budget) return
      while (bytes + added > budget) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }
      entries.set(key, entry)
      bytes += added
    },
  }
}
