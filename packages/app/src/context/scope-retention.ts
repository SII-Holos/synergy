export function createScopeRetention(evict: (scopeKey: string) => void, inactiveLimit = 8) {
  const leases = new Map<string, number>()
  const inactive = new Set<string>()

  return {
    retain(scopeKey: string) {
      inactive.delete(scopeKey)
      leases.set(scopeKey, (leases.get(scopeKey) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = (leases.get(scopeKey) ?? 1) - 1
        if (remaining > 0) {
          leases.set(scopeKey, remaining)
          return
        }
        leases.delete(scopeKey)
        evict(scopeKey)
      }
    },
    touch(scopeKey: string) {
      if (leases.has(scopeKey)) return
      inactive.delete(scopeKey)
      inactive.add(scopeKey)
      while (inactive.size > inactiveLimit) {
        const oldest = inactive.values().next().value
        if (oldest === undefined) break
        inactive.delete(oldest)
        evict(oldest)
      }
    },
  }
}
