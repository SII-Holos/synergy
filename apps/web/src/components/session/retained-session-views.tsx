import { For, createRenderEffect, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import {
  createResidencyBudget,
  pauseHiddenScroll,
  useViewResidency,
  ViewActivityProvider,
} from "@/context/view-residency"

export type SessionViewOwner = { server: string; scopeID: string; sessionID: string; generation: string }
export function RetainedSessionViews(props: {
  owner: SessionViewOwner
  invalidated?: { scopeID: string; sessionID: string }
  render(owner: SessionViewOwner): JSX.Element
}) {
  const budget = useViewResidency()?.sessions ?? createResidencyBudget(6)
  type Entry = { owner: SessionViewOwner; key: string; release(): void }
  const entries = new Map<string, Entry>()
  const [views, setViews] = createSignal<Entry[]>([])
  const key = () => JSON.stringify(props.owner)
  const remove = (entry: Entry) => {
    entry.release()
    entries.delete(entry.key)
    setViews([...entries.values()])
  }
  createRenderEffect(() => {
    const owner = { ...props.owner }
    const selected = key()
    const invalidated = props.invalidated
    for (const entry of entries.values()) {
      if (
        (invalidated?.scopeID === entry.owner.scopeID && invalidated.sessionID === entry.owner.sessionID) ||
        entry.owner.server !== owner.server ||
        (entry.owner.scopeID === owner.scopeID && entry.owner.generation !== owner.generation)
      )
        remove(entry)
      else budget.active(entry, entry.key === selected)
    }
    if (entries.has(selected) || (invalidated?.scopeID === owner.scopeID && invalidated.sessionID === owner.sessionID))
      return
    const entry: Entry = { owner, key: selected, release: () => {} }
    entries.set(selected, entry)
    entry.release = budget.retain(entry, () => remove(entry))
    setViews([...entries.values()])
  })
  onCleanup(() => {
    for (const entry of entries.values()) entry.release()
    entries.clear()
  })
  return (
    <For each={views()}>
      {(entry) => {
        const active = () => entry.key === key()
        return (
          <ViewActivityProvider active={active}>
            <div
              ref={(element) => pauseHiddenScroll(element, active)}
              data-session-resident={entry.key}
              hidden={!active()}
              inert={!active()}
              class="h-full min-h-0 min-w-0 flex-1"
              style={{ display: active() ? "flex" : "none", "flex-direction": "column" }}
            >
              {untrack(() => props.render(entry.owner))}
            </div>
          </ViewActivityProvider>
        )
      }}
    </For>
  )
}
