import { createSignal, type Accessor } from "solid-js"

export interface WorkbenchPanelLoader<T> {
  component: Accessor<T | null>
  loading: Accessor<boolean>
  error: Accessor<unknown | null>
  load(): Promise<void>
}

type Module<T> = { loader: () => Promise<{ default: T }>; component?: T; pending?: Promise<T> }
const modules = new WeakMap<object, Module<unknown>>()

export function createWorkbenchPanelLoader<T>(
  loader: (() => Promise<{ default: T }>) | undefined,
  initial: T | null = null,
  identity: object | undefined = loader,
): WorkbenchPanelLoader<T> {
  const cached = identity ? modules.get(identity) : undefined
  const module = cached?.loader === loader ? (cached as Module<T>) : loader ? ({ loader } as Module<T>) : undefined
  if (identity && module) modules.set(identity, module)
  const [component, setComponent] = createSignal<T | null>(initial ?? module?.component ?? null)
  const [loading, setLoading] = createSignal(!component() && Boolean(loader))
  const [error, setError] = createSignal<unknown | null>(null)
  let pending = false

  const load = async () => {
    if (!module || pending || component()) return
    pending = true
    setLoading(true)
    setError(null)
    try {
      module.pending ??= module
        .loader()
        .then((loaded) => {
          module.component = loaded.default
          return loaded.default
        })
        .finally(() => {
          module.pending = undefined
        })
      const loaded = await module.pending
      setComponent(() => loaded)
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
