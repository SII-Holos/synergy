export type GlobalSDKIdentity = { url: string; runtimeID: string; cacheKey: string }
export function createGlobalSDKLifetime<T extends object>(input: {
  create(identity: Readonly<GlobalSDKIdentity>): { value: T; presentation(active: boolean): void; dispose(): void }
  changed(value: T | undefined): void
}) {
  const create = input.create
  const changed = input.changed
  type Entry = {
    key: string
    value: T
    readers: number
    closed: boolean
    presentation(active: boolean): void
    dispose(): void
  }
  let entry: Entry | undefined
  let disposed = false
  const retire = () => {
    const previous = entry
    entry = undefined
    if (!previous) return
    previous.closed = true
    previous.presentation(false)
    previous.dispose()
    changed(undefined)
  }
  const ensure = (input?: GlobalSDKIdentity) => {
    if (disposed) return
    if (!input) {
      retire()
      return
    }
    const identity = Object.freeze({ ...input })
    const key = JSON.stringify([identity.url, identity.runtimeID, identity.cacheKey])
    if (entry?.key === key) return entry.value
    retire()
    const owned = create(identity)
    entry = {
      key,
      value: owned.value,
      presentation: owned.presentation.bind(owned),
      dispose: owned.dispose.bind(owned),
      readers: 0,
      closed: false,
    }
    entry.presentation(false)
    changed(entry.value)
    return entry.value
  }
  return {
    current: () => entry?.value,
    ensure,
    acquire(identity: GlobalSDKIdentity) {
      const value = ensure(identity)
      const owned = entry
      if (!value || !owned || owned.value !== value) throw new Error("Runtime identity is unavailable")
      if (owned.readers++ === 0) owned.presentation(true)
      let released = false
      return {
        value,
        release() {
          if (released) return
          released = true
          if (owned.closed) return
          if (--owned.readers === 0) owned.presentation(false)
        },
      }
    },
    dispose() {
      disposed = true
      retire()
    },
  }
}
