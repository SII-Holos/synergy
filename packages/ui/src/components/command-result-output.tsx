import { type AssistantMessage, type TextPart } from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Markdown } from "./markdown"
import { Icon } from "./icon"

import "./command-result-output.css"
import { getSemanticIcon } from "./semantic-icon"
import { messageCreatedTime } from "./message-time"

const commandOutputLabelDescriptor = { id: "ui.commandResultOutput.label", message: "Command output" }

export function CommandResultOutput(props: {
  message: AssistantMessage
  partIDs?: readonly string[]
  showHeader?: boolean
  classes?: {
    root?: string
    container?: string
  }
}) {
  const { _, i18n } = useLingui()
  const data = useData()
  const view = data.view

  const parts = createMemo(() =>
    view.partsFor(props.message.id).filter((part) => !props.partIDs || props.partIDs.includes(part.id)),
  )

  const commandName = createMemo(() => props.message.metadata?.commandName as string | undefined)

  const timestamp = createMemo(() => messageCreatedTime(props.message.time.created, i18n?.()?.locale))

  const textContent = createMemo(() => {
    return parts()
      .filter((p) => p.type === "text")
      .map((p) => (p as TextPart).text)
      .join("\n")
  })

  const label = createMemo(() => {
    const name = commandName()
    if (name) return `/${name}`
    return _(commandOutputLabelDescriptor)
  })

  return (
    <div data-component="command-result-output" class={props.classes?.root}>
      <div data-slot="command-result-container" class={props.classes?.container}>
        <Show when={props.showHeader !== false}>
          <div data-slot="command-result-header">
            <div data-slot="command-result-source">
              <Icon name={getSemanticIcon("settings.commands")} size="small" />
              <span data-slot="command-result-label">{label()}</span>
            </div>
            <span data-slot="command-result-time">{timestamp()}</span>
          </div>
        </Show>
        <div data-slot="command-result-body">
          <Markdown data-slot="command-result-markdown" text={textContent()} />
        </div>
      </div>
    </div>
  )
}
