/**
 * Unified plugin slot outlet.
 *
 * Renders every trusted component registered into one host-declared slot.
 * Each entry is lazy-loaded with a disposed guard (a reload or unregister
 * while the load is in flight must not mount a stale component), wrapped in
 * the shared plugin error boundary, and ordered by the registry's stable
 * sort. When the slot has no entries the caller's fallback renders.
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
  createEffect(() => {
    const loader = props.entry.loader
    props.entry
    props.session
    if (!loader) return
    let disposed = false
    void loader().then(
      (value) => {
        if (disposed) return
        const Loaded = value.default as Component<object>
        setComponent(() => (props: object) => createComponent(Loaded, props))
      },
      () => {
        if (!disposed) setComponent()
      },
    )
    onCleanup(() => {
      disposed = true
    })
  })
  return Show({
    get when() {
      return component()
    },
    children: createComponent(PluginErrorBoundary, {
      pluginId: props.entry.pluginId ?? "",
      componentName: props.entry.id,
      children: createComponent(Dynamic, {
        get component() {
          return component()!
        },
      }),
    }),
  })
}

export function SlotOutlet(props: {
  slot: string
  session?: boolean
  fallback?: JSX.Element
  registry?: SlotRegistry
  /** Render only the entry with this id (used by single-entry surfaces). */
  only?: string
}) {
  const registry = props.registry ?? pluginSlots
  const [version, setVersion] = createSignal(0)
  onCleanup(registry.subscribe(() => setVersion((value) => value + 1)))
  const entries = createMemo(() => {
    version()
    const listed = registry.list(props.slot).filter((entry) => filterSlotEntry(entry, { session: props.session }))
    return props.only ? listed.filter((entry) => entry.id === props.only) : listed
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
