export function createMessageArrivalState(now = () => performance.now()) {
  const pending = new Map<string, number>()
  const key = (owner: readonly string[], messageID: string) => JSON.stringify([...owner, messageID])
  const prune = () => {
    for (const [id, expires] of pending) if (expires <= now()) pending.delete(id)
  }
  return {
    add(owner: readonly string[], messageID: string) {
      prune()
      pending.set(key(owner, messageID), now() + 2000)
      while (pending.size > 64) pending.delete(pending.keys().next().value!)
    },
    take(owner: readonly string[], messageID: string) {
      const id = key(owner, messageID)
      const expires = pending.get(id)
      pending.delete(id)
      return expires !== undefined && expires > now()
    },
    handoff(owner: readonly string[], optimisticID: string, canonicalID: string) {
      if (optimisticID === canonicalID) return
      const id = key(owner, optimisticID)
      const expires = pending.get(id)
      pending.delete(id)
      if (expires !== undefined && expires > now()) pending.set(key(owner, canonicalID), expires)
    },
    remove(owner: readonly string[], messageID: string) {
      pending.delete(key(owner, messageID))
    },
  }
}
