import {
  ErrorBoundary,
  For,
  Show,
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

export interface SelectionExtensionEntry extends SlotEntryBase {
  slot: "selection.extension"
  loader?: () => Promise<{ default: Component<object> }>
}

/** Selection extension entries, grouped via the shared slot registry. */
const registry = new SlotRegistry<SelectionExtensionEntry>()

export function registerSelectionExtension(entry: SelectionExtensionEntry): () => void {
  return registry.register(entry)
}

function subscribe(listener: () => void) {
  return registry.subscribe(listener)
}

function EntryView(props: { entry: SelectionExtensionEntry; mountKey: string }) {
  const [component, setComponent] = createSignal<Component<object>>()
  createEffect(() => {
    props.mountKey
    let disposed = false
    const loader = props.entry.loader
    if (!loader) return
    void loader().then(
      (value) => {
        if (!disposed) {
          const Loaded = value.default as Component<object>
          setComponent(() => (props: object) => createComponent(Loaded, props))
        }
      },
      () => {
        if (!disposed) setComponent()
      },
    )
    onCleanup(() => {
      disposed = true
    })
  })
  return (
    <Show when={component()}>
      {(Extension) => (
        <ErrorBoundary fallback={() => null}>
          <Dynamic component={Extension()} />
        </ErrorBoundary>
      )}
    </Show>
  )
}

export function SelectionExtensionOutlet(props: { mountKey: string }) {
  const [version, setVersion] = createSignal(0)
  onCleanup(subscribe(() => setVersion((value) => value + 1)))
  const ordered = createMemo(() => {
    version()
    return registry.list("selection.extension")
  })
  return <For each={ordered()}>{(entry) => <EntryView entry={entry} mountKey={props.mountKey} />}</For>
}
