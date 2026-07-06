import { type AssistantMessage, type TextPart } from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { createMemo } from "solid-js"
import { Markdown } from "./markdown"
import { Icon } from "./icon"
import { DateTime } from "luxon"

import "./command-result-output.css"
import { getSemanticIcon } from "./semantic-icon"

export function CommandResultOutput(props: {
  message: AssistantMessage
  classes?: {
    root?: string
    container?: string
  }
}) {
  const data = useData()

  const parts = createMemo(() => data.store.part[props.message.id] ?? [])

  const commandName = createMemo(() => props.message.metadata?.commandName as string | undefined)

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

  const label = createMemo(() => {
    const name = commandName()
    if (name) return `/${name}`
    return "Command output"
  })

  return (
    <div data-component="command-result-output" class={props.classes?.root}>
      <div data-slot="command-result-container" class={props.classes?.container}>
        <div data-slot="command-result-header">
          <div data-slot="command-result-source">
            <Icon name={getSemanticIcon("settings.commands")} size="small" />
            <span data-slot="command-result-label">{label()}</span>
          </div>
          <span data-slot="command-result-time">{timestamp()}</span>
        </div>
        <div data-slot="command-result-body">
          <Markdown data-slot="command-result-markdown" text={textContent()} />
        </div>
      </div>
    </div>
  )
}
