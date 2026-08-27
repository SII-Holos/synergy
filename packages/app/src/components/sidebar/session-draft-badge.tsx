import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { sidebar } from "@/locales/messages"
import { hasDraftSession } from "@/context/prompt/draft-index"

export function SessionDraftBadge(props: { sessionID: string }) {
  const { _ } = useLingui()
  return (
    <Show when={hasDraftSession(props.sessionID)}>
      <span class="sb-session-draft-badge">[{_(sidebar.draftBadge)}]</span>
    </Show>
  )
}
