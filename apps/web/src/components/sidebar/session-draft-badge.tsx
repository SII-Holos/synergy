import { Show } from "solid-js"

export function SessionDraftBadge(props: { sessionID: string; dirty: boolean; label: string; class?: string }) {
  return (
    <Show when={props.dirty}>
      <span class={props.class ?? "sb-session-draft-badge"} data-draft-badge={props.sessionID}>
        [{props.label}]
      </span>
    </Show>
  )
}
