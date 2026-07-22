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

export interface SelectionExtensionEntry {
  id: string
  order: number
  pluginId: string
  loader: () => Promise<{ default: Component<object> }>
}

const entries: SelectionExtensionEntry[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function registerSelectionExtension(entry: SelectionExtensionEntry) {
  if (entries.some((candidate) => candidate.id === entry.id))
    throw new Error(`Duplicate selection extension ${entry.id}`)
  entries.push(entry)
  notify()
  return () => {
    const index = entries.indexOf(entry)
    if (index < 0) return
    entries.splice(index, 1)
    notify()
  }
}

function EntryView(props: { entry: SelectionExtensionEntry; mountKey: string }) {
  const [component, setComponent] = createSignal<Component<object>>()
  createEffect(() => {
    props.mountKey
    let disposed = false
    void props.entry.loader().then(
      (value) => {
        if (!disposed) {
          const Loaded = value.default
          setComponent(() => (props) => createComponent(Loaded, props))
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
    return entries.toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  })
  return <For each={ordered()}>{(entry) => <EntryView entry={entry} mountKey={props.mountKey} />}</For>
}
