import { MonotonicKeySpace } from "./monotonic-key-space"

export function createScopeReconnectRecovery(publish: (scopeKey: string, generation: number) => void) {
  const versions = new MonotonicKeySpace()
  const lifecycles = new Map<string, object>()

  const version = (scopeKey: string) => versions.get(scopeKey)

  const lifecycle = (scopeKey: string) => {
    const active = lifecycles.get(scopeKey)
    if (active) return active
    const created = {}
    lifecycles.set(scopeKey, created)
    return created
  }

  const run = async (scopeKey: string, generation: number, recover: () => Promise<boolean>) => {
    const activeLifecycle = lifecycle(scopeKey)
    const recovered = await recover()
    if (!recovered) return false
    if (lifecycles.get(scopeKey) !== activeLifecycle) return false
    if (generation <= versions.get(scopeKey)) return true
    versions.set(scopeKey, generation)
    publish(scopeKey, generation)
    return true
  }

  const release = (scopeKey: string) => {
    versions.delete(scopeKey)
    lifecycles.delete(scopeKey)
  }

  return { version, run, release }
}
