import { createSignal, type Accessor } from "solid-js"

export interface WorkbenchPanelLoader<T> {
  component: Accessor<T | null>
  loading: Accessor<boolean>
  error: Accessor<unknown | null>
  load(): Promise<void>
}

export function createWorkbenchPanelLoader<T>(
  loader: (() => Promise<{ default: T }>) | undefined,
  initial: T | null = null,
): WorkbenchPanelLoader<T> {
  const [component, setComponent] = createSignal<T | null>(initial)
  const [loading, setLoading] = createSignal(!initial && Boolean(loader))
  const [error, setError] = createSignal<unknown | null>(null)
  let pending = false

  const load = async () => {
    if (!loader || pending) return
    pending = true
    setLoading(true)
    setError(null)
    try {
      const loaded = await loader()
      setComponent(() => loaded.default)
    } catch (cause) {
      setComponent(null)
      setError(cause)
    } finally {
      pending = false
      setLoading(false)
    }
  }

  return { component, loading, error, load }
}
