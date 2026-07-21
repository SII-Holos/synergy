import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"

export type ComposerSlotName =
  | "composer.above"
  | "composer.below"
  | "composer.toolbar.left"
  | "composer.toolbar.right"
  | "composer.add-menu"
  | "composer.start-option"

export interface ComposerSlotProps {
  slot: ComposerSlotName
  sessionId?: string
}

export interface ComposerSlotOutletProps extends ComposerSlotProps {
  class?: string
}

export interface ExternalComposerSlotEntry {
  id: string
  component?: Component<ComposerSlotProps>
  loader?: () => Promise<{ default: Component<ComposerSlotProps> }>
}

export let externalComposerSlotLookup:
  | ((slot: ComposerSlotName) => readonly ExternalComposerSlotEntry[] | undefined)
  | undefined

export function setExternalComposerSlotLookup(
  fn: (slot: ComposerSlotName) => readonly ExternalComposerSlotEntry[] | undefined,
) {
  externalComposerSlotLookup = fn
}

const [externalComposerSlotNotify, setExternalComposerSlotNotify] = createSignal(0)

export function notifyExternalComposerSlotsChanged() {
  setExternalComposerSlotNotify((version) => version + 1)
}

function ComposerSlotEntryView(props: { entry: ExternalComposerSlotEntry; slotProps: ComposerSlotProps }) {
  const [component, setComponent] = createSignal<Component<ComposerSlotProps> | undefined>(props.entry.component)
  const [loading, setLoading] = createSignal(!props.entry.component && !!props.entry.loader)

  createEffect(() => {
    const entry = props.entry
    setComponent(() => entry.component)
    setLoading(!entry.component && !!entry.loader)
    if (!entry.loader || entry.component) return
    let disposed = false
    entry.loader().then(
      (mod) => {
        if (disposed) return
        setComponent(() => mod.default)
        setLoading(false)
      },
      () => {
        if (!disposed) setLoading(false)
      },
    )
    onCleanup(() => {
      disposed = true
    })
  })

  return (
    <Show when={!loading() && component()}>
      {(SlotComponent) => (
        <ErrorBoundary fallback={() => null}>
          <Dynamic component={SlotComponent()} {...props.slotProps} />
        </ErrorBoundary>
      )}
    </Show>
  )
}

export function ComposerSlotOutlet(props: ComposerSlotOutletProps) {
  const entries = createMemo(() => {
    externalComposerSlotNotify()
    return [...(externalComposerSlotLookup?.(props.slot) ?? [])]
  })

  return (
    <Show when={entries().length > 0}>
      <div data-slot={props.slot} class={props.class}>
        <For each={entries()}>{(entry) => <ComposerSlotEntryView entry={entry} slotProps={props} />}</For>
      </div>
    </Show>
  )
}
