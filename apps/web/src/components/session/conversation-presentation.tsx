import { createMemo, createRenderEffect, on, type JSX } from "solid-js"

export function ConversationPresentation(props: {
  owner: readonly [server: string, scope: string, session: string]
  ready: boolean
  onLeave?: () => void
  children: JSX.Element
}) {
  const owner = createMemo(() => JSON.stringify(props.owner))
  createRenderEffect(on(owner, () => props.onLeave?.()))
  return (
    <div
      data-ui-part="conversation"
      data-conversation-presentation
      class="relative flex-1 min-h-0 min-w-0 overflow-hidden"
    >
      <div data-conversation-current class="relative h-full min-h-0 min-w-0 flex flex-col">
        {props.children}
      </div>
    </div>
  )
}
