import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"

export type MessageSlotName = string

export interface MessageSlotProps {
  slot: MessageSlotName
  sessionId?: string
  messageId?: string
}

export interface ExternalMessageSlotEntry {
  id: string
  component?: Component<MessageSlotProps>
  loader?: () => Promise<{ default: Component<MessageSlotProps> }>
}

export let externalMessageSlotLookup:
  | ((slot: MessageSlotName) => readonly ExternalMessageSlotEntry[] | undefined)
  | undefined

export function setExternalMessageSlotLookup(
  fn: (slot: MessageSlotName) => readonly ExternalMessageSlotEntry[] | undefined,
) {
  externalMessageSlotLookup = fn
}

const [externalMessageSlotNotify, setExternalMessageSlotNotify] = createSignal(0)

export function notifyExternalMessageSlotsChanged() {
  setExternalMessageSlotNotify((version) => version + 1)
}

function MessageSlotEntryView(props: { entry: ExternalMessageSlotEntry; slotProps: MessageSlotProps }) {
  const [component, setComponent] = createSignal<Component<MessageSlotProps> | undefined>(props.entry.component)
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

export function MessageSlotOutlet(props: MessageSlotProps) {
  const entries = createMemo(() => {
    externalMessageSlotNotify()
    return [...(externalMessageSlotLookup?.(props.slot) ?? [])]
  })

  return <For each={entries()}>{(entry) => <MessageSlotEntryView entry={entry} slotProps={props} />}</For>
}
