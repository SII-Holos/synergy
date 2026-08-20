/**
 * Unified plugin slot outlet.
 *
 * Renders every trusted component registered into one host-declared slot.
 * Each entry is lazy-loaded with a disposed guard (a reload or unregister
 * while the load is in flight must not mount a stale component), wrapped in
 * the shared plugin error boundary, and ordered by the registry's stable
 * sort. When the slot has no entries the caller's fallback renders.
 *
 * A failed loader renders the shared plugin error card instead of silently
 * disappearing: the entry's component becomes a throwing component so the
 * existing plugin error boundary surfaces the failure.
 *
 * Implemented without JSX so bun:test can import and exercise it directly
 * (bun's test transform compiles .tsx JSX to React.createElement).
 */
import {
  For,
  Show,
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { pluginSlots, type SlotEntry, type SlotEntryBase, type SlotRegistry } from "./slot-registry"
import { PluginErrorBoundary } from "./components/plugin-error-boundary"

/** Apply the slot entry's `when` conditions against the outlet context. */
export function filterSlotEntry(entry: SlotEntryBase, context: { session?: boolean }): boolean {
  if (!entry.when) return true
  if (entry.when.session !== undefined && entry.when.session !== context.session) return false
  return true
}

function SlotEntryView(props: { entry: SlotEntryBase; session?: boolean }) {
  const [component, setComponent] = createSignal<Component<object>>()
  const [loadError, setLoadError] = createSignal<unknown>()
  createEffect(() => {
    const loader = props.entry.loader
    props.entry
    props.session
    if (!loader) return
    // The entry (or session context) changed: drop the previous entry's
    // component/error state before starting the new load.
    setComponent()
    setLoadError()
    let disposed = false
    void loader().then(
      (value) => {
        if (disposed) return
        const Loaded = value.default as Component<object>
        setComponent(() => (props: object) => createComponent(Loaded, props))
      },
      (error: unknown) => {
        if (disposed) return
        setLoadError(error)
      },
    )
    onCleanup(() => {
      disposed = true
    })
  })
  // A failed loader surfaces as a component that throws on render, so the
  // shared plugin error boundary below renders the standard error card.
  const viewComponent = createMemo<Component<object> | undefined>(() => {
    const loaded = component()
    if (loaded) return loaded
    if (loadError())
      return () => {
        throw loadError()
      }
    return undefined
  })
  return createComponent(PluginErrorBoundary, {
    pluginId: props.entry.pluginId ?? "",
    componentName: props.entry.id,
    // Getter children: the entry element is created each time the boundary
    // reads children, so rendering (including the throwing component produced
    // by a failed loader) happens inside the boundary's protected scope.
    // Eager elements or plain function children would render outside it and
    // escape the boundary.
    get children() {
      return Show({
        get when() {
          return viewComponent()
        },
        children: createComponent(Dynamic, {
          get component() {
            return viewComponent()!
          },
        }),
      })
    },
  })
}

export function SlotOutlet(props: {
  slot: string
  session?: boolean
  fallback?: JSX.Element
  registry?: SlotRegistry
}) {
  const registry = props.registry ?? pluginSlots
  const [version, setVersion] = createSignal(0)
  onCleanup(registry.subscribe(() => setVersion((value) => value + 1)))
  const entries = createMemo(() => {
    version()
    return registry.list(props.slot).filter((entry) => filterSlotEntry(entry, { session: props.session }))
  })
  return Show({
    get when() {
      return entries().length > 0
    },
    fallback: props.fallback,
    children: For({
      get each() {
        return entries()
      },
      children: (entry: SlotEntryBase) => createComponent(SlotEntryView, { entry, session: props.session }),
    }),
  })
}

export type { SlotEntry }
