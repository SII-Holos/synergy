import { createMemo, Show, type Component, type JSX } from "solid-js"
import type { Part as PartType, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import h from "solid-js/h"
import { useData } from "../context/data"
import { Icon } from "./icon"
import { Message } from "./message-part"
import { getSemanticIcon } from "./semantic-icon"
import { metadataRequiredFeatures } from "./tool-result-presentation"
import {
  getSpecialUserMessageBubbleView,
  isBlueprintControl,
  isWorkflowControl,
  type SpecialUserMessageBubbleView,
} from "./special-user-message-model"
import "./special-user-message.css"

export { getSpecialUserMessageBubbleView, type SpecialUserMessageBubbleView } from "./special-user-message-model"

export interface SpecialUserMessageProps {
  message: UserMessage
  parts: PartType[]
}

export interface SpecialUserMessageRenderer {
  id: string
  match(message: UserMessage): boolean
  component: Component<SpecialUserMessageProps>
}

const renderers: SpecialUserMessageRenderer[] = []

export function registerSpecialUserMessageRenderer(renderer: SpecialUserMessageRenderer) {
  const index = renderers.findIndex((item) => item.id === renderer.id)
  if (index >= 0) {
    renderers[index] = renderer
    return
  }
  renderers.push(renderer)
}

export function getSpecialUserMessageRenderer(message: UserMessage): Component<SpecialUserMessageProps> | undefined {
  return renderers.find((renderer) => renderer.match(message))?.component
}

export function hasSpecialUserMessageRenderer(message: UserMessage): boolean {
  return getSpecialUserMessageRenderer(message) !== undefined
}

// Keep the descriptor parameter explicit so localization source checks can classify dynamic view labels.
function localizeMessageDescriptor(
  descriptor: MessageDescriptor,
  _: (descriptor: MessageDescriptor) => string,
): string {
  return _(descriptor)
}

function SpecialUserBubbleMessage(
  props: SpecialUserMessageProps & { view: SpecialUserMessageBubbleView },
): JSX.Element {
  const { _ } = useLingui()
  const data = useData()
  const feature = () =>
    props.view.kind?.startsWith("lightloop")
      ? "light-loop"
      : props.view.kind?.startsWith("lattice")
        ? "lattice"
        : "blueprint"
  const retainedParts = createMemo(() => {
    if (props.view.kind?.endsWith("-request")) return props.parts
    const attachments = props.parts.filter((part) => part.type === "attachment")
    const userPrompt = props.message.metadata?.userPrompt
    if (typeof userPrompt === "string" && userPrompt.trim()) return [...props.view.parts, ...attachments]
    return attachments
  })
  const displayedParts = createMemo(() => {
    const included = new Set(props.view.parts.map((part) => part.id))
    return [...props.view.parts, ...props.parts.filter((part) => part.type === "attachment" && !included.has(part.id))]
  })

  return (
    <Show
      when={data.hasFeature(feature()) && metadataRequiredFeatures(props.message.metadata).every(data.hasFeature)}
      fallback={
        <Show when={retainedParts().length}>
          <Message message={props.message} parts={retainedParts()} userVariant="turn-bubble" />
        </Show>
      }
    >
      <div data-component="special-user-message" data-kind={props.view.kind} data-layout="user-bubble">
        <div data-slot="special-message-badges">
          <span data-slot="special-message-badge" data-kind="source">
            {localizeMessageDescriptor(props.view.label, _)}
          </span>
          {props.view.status ? (
            <span data-slot="special-message-status" data-tone={props.view.status.tone}>
              <Icon
                name={
                  props.view.status.tone === "success"
                    ? getSemanticIcon("state.success")
                    : getSemanticIcon("state.warning")
                }
                size="small"
                aria-hidden="true"
              />
              <span>{localizeMessageDescriptor(props.view.status.label, _)}</span>
            </span>
          ) : null}
        </div>
        <Message message={props.message} parts={displayedParts()} userVariant="turn-bubble" />
      </div>
    </Show>
  )
}

function WorkflowUserRequestMessage(props: SpecialUserMessageProps): JSX.Element {
  return (
    <SpecialUserBubbleMessage
      message={props.message}
      parts={props.parts}
      view={getSpecialUserMessageBubbleView(props.message, props.parts)!}
    />
  )
}

function HiddenSpecialMessage(): JSX.Element {
  return h("div", {
    "data-component": "special-user-message",
    "data-kind": "hidden",
    hidden: true,
  }) as unknown as JSX.Element
}

function BlueprintControlMessage(props: SpecialUserMessageProps): JSX.Element {
  return (
    <SpecialUserBubbleMessage
      message={props.message}
      parts={props.parts}
      view={getSpecialUserMessageBubbleView(props.message, props.parts)!}
    />
  )
}

function WorkflowControlMessage(props: SpecialUserMessageProps): JSX.Element {
  return (
    <SpecialUserBubbleMessage
      message={props.message}
      parts={props.parts}
      view={getSpecialUserMessageBubbleView(props.message, props.parts)!}
    />
  )
}

registerSpecialUserMessageRenderer({
  id: "compaction-boundary",
  match(message) {
    return message.metadata?.compactionBoundary === true
  },
  component: HiddenSpecialMessage,
})

registerSpecialUserMessageRenderer({
  id: "blueprint-control",
  match(message) {
    return isBlueprintControl(message)
  },
  component: BlueprintControlMessage,
})

registerSpecialUserMessageRenderer({
  id: "workflow-control",
  match(message) {
    return isWorkflowControl(message)
  },
  component: WorkflowControlMessage,
})

registerSpecialUserMessageRenderer({
  id: "workflow-user-request",
  match(message) {
    return (
      typeof message.metadata?.workflow === "string" &&
      ["plan", "lattice", "lightloop"].includes(message.metadata.workflow)
    )
  },
  component: WorkflowUserRequestMessage,
})
