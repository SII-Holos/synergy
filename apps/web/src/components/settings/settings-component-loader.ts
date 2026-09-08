import { createSignal, type Accessor } from "solid-js"

export interface SettingsComponentSource<T> {
  component?: T
  loader?: () => Promise<{ default: T }>
}

export interface SettingsComponentLoader<T> {
  component: Accessor<T | null>
  loading: Accessor<boolean>
  load(source: SettingsComponentSource<T>): Promise<void>
}

export function createSettingsComponentLoader<T>(): SettingsComponentLoader<T> {
  const [component, setComponent] = createSignal<T | null>(null)
  const [loading, setLoading] = createSignal(true)
  let requestId = 0

  const load = async (source: SettingsComponentSource<T>) => {
    const currentRequestId = ++requestId

    if (source.component) {
      setComponent(() => source.component!)
      setLoading(false)
      return
    }

    if (!source.loader) {
      setComponent(null)
      setLoading(false)
      return
    }

    setComponent(null)
    setLoading(true)
    try {
      const loaded = await source.loader()
      if (currentRequestId !== requestId) return
      setComponent(() => loaded.default)
    } catch {
      if (currentRequestId !== requestId) return
      setComponent(null)
    } finally {
      if (currentRequestId === requestId) setLoading(false)
    }
  }

  return { component, loading, load }
}
