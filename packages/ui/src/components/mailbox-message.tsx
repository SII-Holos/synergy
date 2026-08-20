import { type AssistantMessage, type TextPart } from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Markdown } from "./markdown"
import { Icon } from "./icon"

import "./mailbox-message.css"
import { getSemanticIcon } from "./semantic-icon"
import { messageCreatedTime } from "./message-time"

const fromSessionDescriptor = { id: "ui.mailbox.fromSession", message: "From {source}" }

export function MailboxMessage(props: {
  message: AssistantMessage
  classes?: {
    root?: string
    container?: string
  }
}) {
  const { _, i18n } = useLingui()
  const data = useData()
  const view = data.view

  const parts = createMemo(() => view.partsFor(props.message.id))

  const sourceName = createMemo(() => props.message.metadata?.sourceName as string | undefined)
  const sourceSessionID = createMemo(() => {
    const origin = (props.message as { origin?: { sessionID?: string } }).origin
    return (origin?.sessionID ?? props.message.metadata?.sourceSessionID) as string | undefined
  })
  const sourceLabel = createMemo(() => sourceName() ?? sourceSessionID() ?? "another session")

  const timestamp = createMemo(() => messageCreatedTime(props.message.time.created, i18n?.()?.locale))

  const textContent = createMemo(() => {
    return parts()
      .filter((p) => p.type === "text")
      .map((p) => (p as TextPart).text)
      .join("\n")
  })

  return (
    <div data-component="mailbox-message" class={props.classes?.root}>
      <div data-slot="mailbox-message-container" class={props.classes?.container}>
        <div data-slot="mailbox-message-header">
          <div data-slot="mailbox-message-source">
            <Icon name={getSemanticIcon("session.inbox")} size="small" />
            <span data-slot="mailbox-message-source-label">
              <Show
                when={sourceSessionID()}
                fallback={
                  <span data-slot="mailbox-message-source-text">
                    {_({ ...fromSessionDescriptor, values: { source: sourceLabel() } })}
                  </span>
                }
              >
                <button
                  data-slot="mailbox-message-source-link"
                  onClick={() => data.navigateToSession?.(sourceSessionID()!)}
                >
                  {_({ ...fromSessionDescriptor, values: { source: sourceLabel() } })}
                </button>
              </Show>
            </span>
          </div>
          <span data-slot="mailbox-message-time">{timestamp()}</span>
        </div>
        <div data-slot="mailbox-message-body">
          <Markdown data-slot="mailbox-message-markdown" text={textContent()} />
        </div>
      </div>
    </div>
  )
}
