import type { VirtualizerHandle } from "virtua/solid"

type Layout = { keys: readonly string[]; width: number; cache: VirtualizerHandle["cache"] }

export function conversationReadingIndex(
  virtual: Pick<VirtualizerHandle, "scrollOffset" | "findStartIndex" | "getItemOffset">,
  count: number,
  margin: number,
) {
  if (!count) return
  let index = Math.min(virtual.findStartIndex(), count - 1)
  const cutoff = virtual.scrollOffset - margin + 100
  if (virtual.getItemOffset(index) > cutoff) return
  while (index + 1 < count && virtual.getItemOffset(index + 1) <= cutoff) index++
  return index
}

export function createConversationLayoutCache(maxBytes = 4 * 1024 * 1024, maxEntries = 128) {
  const entries = new Map<string, Layout & { bytes: number }>()
  let bytes = 0
  const remove = (identity: string) => {
    const previous = entries.get(identity)
    if (!previous) return
    bytes -= previous.bytes
    entries.delete(identity)
  }
  return {
    retain(identity: string, layout: Layout) {
      remove(identity)
      if (layout.width <= 0 || !Number.isFinite(layout.width)) return
      const retained = {
        keys: [...layout.keys],
        width: layout.width,
        cache: structuredClone(layout.cache),
      }
      const size = JSON.stringify([identity, retained]).length * 2
      if (size > maxBytes) return
      entries.set(identity, { ...retained, bytes: size })
      bytes += size
      while (bytes > maxBytes || entries.size > maxEntries) remove(entries.keys().next().value!)
    },
    restore(identity: string, keys: readonly string[], width: number) {
      const entry = entries.get(identity)
      if (
        !entry ||
        width !== entry.width ||
        keys.length !== entry.keys.length ||
        keys.some((key, index) => key !== entry.keys[index])
      )
        return
      entries.delete(identity)
      entries.set(identity, entry)
      return structuredClone(entry.cache)
    },
    get size() {
      return entries.size
    },
    get bytes() {
      return bytes
    },
  }
}

export function createConversationLayoutBinding(
  cache: ReturnType<typeof createConversationLayoutCache>,
  view: {
    identity(): string
    keys(): readonly string[]
    width(): number
    changed(value: VirtualizerHandle | undefined): void
  },
) {
  let bound: { handle: VirtualizerHandle; identity: string; width: number } | undefined
  return {
    restore: () => cache.restore(view.identity(), view.keys(), view.width()),
    resize(width: number) {
      if (bound && width > 0 && width !== bound.width) bound = undefined
    },
    ref(value: VirtualizerHandle | undefined) {
      if (value) bound = { handle: value, identity: view.identity(), width: view.width() }
      else if (bound) {
        const width = view.width()
        if (view.identity() === bound.identity && (width === 0 || width === bound.width))
          cache.retain(bound.identity, { keys: view.keys(), width: bound.width, cache: bound.handle.cache })
        bound = undefined
      }
      view.changed(value)
    },
  }
}
