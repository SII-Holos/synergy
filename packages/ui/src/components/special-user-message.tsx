import { For, Show, createMemo, type Component } from "solid-js"
import type { Part as PartType, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { Message } from "./message-part"
import "./special-user-message.css"

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

function metadataText(message: UserMessage, key: string) {
  const value = message.metadata?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function Field(props: { label: string; value: string | undefined }) {
  return (
    <Show when={props.value}>
      {(value) => (
        <div data-slot="special-message-field">
          <div data-slot="special-message-field-label">{props.label}</div>
          <div data-slot="special-message-field-value">{value()}</div>
        </div>
      )}
    </Show>
  )
}

function SourceSessionLink(props: { sessionID: string | undefined }) {
  const data = useData()
  return (
    <Show when={props.sessionID}>
      {(sessionID) => (
        <button data-slot="special-message-link" onClick={() => data.navigateToSession?.(sessionID())}>
          Supervisor session
        </button>
      )}
    </Show>
  )
}

function PlanModeUserRequestMessage(props: SpecialUserMessageProps) {
  return (
    <div data-component="special-user-message" data-kind="plan-mode-request" data-tone="plan">
      <Message message={props.message} parts={props.parts} />
    </div>
  )
}

function BlueprintControlMessage(props: SpecialUserMessageProps) {
  const source = createMemo(() => props.message.metadata?.source as string | undefined)
  const title = createMemo(() => metadataText(props.message, "title"))
  const loopID = createMemo(() => metadataText(props.message, "loopID"))
  const noteID = createMemo(() => metadataText(props.message, "noteID"))
  const sourceSessionID = createMemo(() => metadataText(props.message, "sourceSessionID"))

  const view = createMemo(() => {
    switch (source()) {
      case "blueprint_loop_start":
        return {
          tone: "start",
          eyebrow: "Blueprint",
          heading: "Started execution",
          description: "The execution session is now driving this BlueprintLoop.",
        }
      case "blueprint_loop_continuation":
        return {
          tone: "continue",
          eyebrow: "Blueprint",
          heading: "Continued from idle",
          description: "The loop is still running, so the session was asked to inspect progress and continue.",
        }
      case "blueprint_loop_restart":
        return {
          tone: "restart",
          eyebrow: "Supervisor audit",
          heading: "Changes requested",
          description: "The audit found remaining work and returned the loop to the execution session.",
        }
      default:
        return {
          tone: "default",
          eyebrow: "Blueprint",
          heading: "Blueprint event",
          description: "A BlueprintLoop control message was delivered to this session.",
        }
    }
  })

  const userPrompt = createMemo(() => metadataText(props.message, "userPrompt"))
  const restartFields = createMemo(() => [
    { label: "Reason", value: metadataText(props.message, "reason") },
    { label: "Completed", value: metadataText(props.message, "completed") },
    { label: "Remaining", value: metadataText(props.message, "remaining") },
    { label: "Next actions", value: metadataText(props.message, "instructions") },
  ])

  return (
    <div data-component="special-user-message" data-kind="blueprint" data-tone={view().tone}>
      <div data-slot="special-message-body">
        <div data-slot="special-message-header">
          <div data-slot="special-message-heading-row">
            <span data-slot="special-message-eyebrow">{view().eyebrow}</span>
            <span data-slot="special-message-heading">{view().heading}</span>
          </div>
          <SourceSessionLink sessionID={sourceSessionID()} />
        </div>
        <Show when={title()}>{(value) => <div data-slot="special-message-title">{value()}</div>}</Show>
        <div data-slot="special-message-description">{view().description}</div>
        <div data-slot="special-message-meta">
          <Show when={loopID()}>{(id) => <span>Loop {id()}</span>}</Show>
          <Show when={noteID()}>{(id) => <span>Note {id()}</span>}</Show>
        </div>
        <Show when={userPrompt()}>
          {(prompt) => (
            <div data-slot="special-message-user-prompt">
              <div data-slot="special-message-field-label">User instruction</div>
              <div data-slot="special-message-field-value">{prompt()}</div>
            </div>
          )}
        </Show>
        <Show when={source() === "blueprint_loop_restart"}>
          <div data-slot="special-message-fields">
            <For each={restartFields()}>{(field) => <Field label={field.label} value={field.value} />}</For>
          </div>
        </Show>
      </div>
    </div>
  )
}

registerSpecialUserMessageRenderer({
  id: "plan-mode-user-request",
  match(message) {
    return message.metadata?.planModeRequest === true
  },
  component: PlanModeUserRequestMessage,
})

registerSpecialUserMessageRenderer({
  id: "blueprint-control",
  match(message) {
    const source = message.metadata?.source
    return (
      source === "blueprint_loop_start" ||
      source === "blueprint_loop_continuation" ||
      source === "blueprint_loop_restart"
    )
  },
  component: BlueprintControlMessage,
})
