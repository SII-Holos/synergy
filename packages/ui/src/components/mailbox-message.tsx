import { type AssistantMessage, type TextPart } from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { createMemo } from "solid-js"
import { Markdown } from "./markdown"
import { Icon } from "./icon"
import { DateTime } from "luxon"

import "./mailbox-message.css"

export function MailboxMessage(props: {
  message: AssistantMessage
  classes?: {
    root?: string
    container?: string
  }
}) {
  const data = useData()

  const parts = createMemo(() => data.store.part[props.message.id] ?? [])

  const sourceName = createMemo(() => props.message.metadata?.sourceName as string | undefined)
  const sourceSessionID = createMemo(() => props.message.metadata?.sourceSessionID as string | undefined)
  const sourceLabel = createMemo(() => sourceName() ?? sourceSessionID() ?? "another session")

  const timestamp = createMemo(() => {
    const ms = props.message.time.created
    return DateTime.fromMillis(ms).toFormat("HH:mm")
  })

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
            <Icon name="message-square" size="small" />
            <span data-slot="mailbox-message-source-label">
              From{" "}
              <button
                data-slot="mailbox-message-source-link"
                onClick={() => {
                  const id = sourceSessionID()
                  if (id) data.navigateToSession?.(id)
                }}
              >
                {sourceLabel()}
              </button>
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
