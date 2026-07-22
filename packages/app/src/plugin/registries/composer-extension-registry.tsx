import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { ComposerDocumentController } from "@/components/prompt-input/composer-document"

export interface ComposerExtensionProps {
  controller: ComposerDocumentController
  sessionId?: string
}

export interface ComposerExtensionEntry {
  id: string
  order: number
  pluginId: string
  loader: () => Promise<{ default: Component<ComposerExtensionProps> }>
}

const entries: ComposerExtensionEntry[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function registerComposerExtension(entry: ComposerExtensionEntry): () => void {
  if (entries.some((candidate) => candidate.id === entry.id))
    throw new Error(`Duplicate composer extension ${entry.id}`)
  entries.push(entry)
  notify()
  return () => {
    const index = entries.indexOf(entry)
    if (index < 0) return
    entries.splice(index, 1)
    notify()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function EntryView(props: { entry: ComposerExtensionEntry; outlet: ComposerExtensionProps }) {
  const [component, setComponent] = createSignal<Component<ComposerExtensionProps>>()
  createEffect(() => {
    let disposed = false
    void props.entry.loader().then(
      (value) => {
        if (!disposed) setComponent(() => value.default)
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
          <Dynamic component={Extension()} {...props.outlet} />
        </ErrorBoundary>
      )}
    </Show>
  )
}

export function ComposerExtensionOutlet(props: ComposerExtensionProps) {
  const [version, setVersion] = createSignal(0)
  onCleanup(subscribe(() => setVersion((value) => value + 1)))
  const ordered = createMemo(() => {
    version()
    return entries.toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  })
  return <For each={ordered()}>{(entry) => <EntryView entry={entry} outlet={props} />}</For>
}
