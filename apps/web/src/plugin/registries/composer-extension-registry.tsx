import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { ComposerDocumentController } from "@/components/prompt-input/composer-document"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

export interface ComposerExtensionProps {
  controller: ComposerDocumentController
  sessionId?: string
}

export interface ComposerExtensionEntry extends SlotEntryBase {
  slot: "composer.extension"
  loader?: () => Promise<{ default: Component<ComposerExtensionProps> }>
}

/** Composer extension entries, grouped via the shared slot registry. */
const registry = new SlotRegistry<ComposerExtensionEntry>()

export function registerComposerExtension(entry: ComposerExtensionEntry): () => void {
  return registry.register(entry)
}

function subscribe(listener: () => void) {
  return registry.subscribe(listener)
}

function EntryView(props: { entry: ComposerExtensionEntry; outlet: ComposerExtensionProps }) {
  const [component, setComponent] = createSignal<Component<ComposerExtensionProps>>()
  createEffect(() => {
    let disposed = false
    const loader = props.entry.loader
    if (!loader) return
    void loader().then(
      (value) => {
        if (!disposed) setComponent(() => value.default as Component<ComposerExtensionProps>)
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
    return registry.list("composer.extension")
  })
  return <For each={ordered()}>{(entry) => <EntryView entry={entry} outlet={props} />}</For>
}
