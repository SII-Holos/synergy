import { Show } from "solid-js"
import { hasDraftSession } from "../../context/prompt/draft-index"

export function SessionDraftBadge(props: { sessionID: string; label: string; class?: string }) {
  return (
    <Show when={hasDraftSession(props.sessionID)}>
      <span class={props.class ?? "sb-session-draft-badge"} data-draft-badge={props.sessionID}>
        [{props.label}]
      </span>
    </Show>
  )
}
