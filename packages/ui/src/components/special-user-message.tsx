import { For, Show, createEffect, createMemo, createSignal, type Component, type JSX } from "solid-js"
import type { Part as PartType, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import h from "solid-js/h"
import { useData } from "../context"
import { Icon, type IconName } from "./icon"
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

/**
 * The BlueprintLoop control kind (start / continuation / restart / audit) from
 * the canonical origin, falling back to legacy metadata.source for messages
 * written before origin existed.
 */
function blueprintDetail(message: UserMessage): string | undefined {
  const origin = message.origin
  if (origin?.type === "blueprint") return origin.detail
  const source = message.metadata?.source
  return typeof source === "string" && source.startsWith("blueprint_loop_")
    ? source.slice("blueprint_loop_".length)
    : undefined
}

function isBlueprintControl(message: UserMessage): boolean {
  return message.origin?.type === "blueprint" || blueprintDetail(message) !== undefined
}

function Field(props: { label: string; value: string | undefined }): JSX.Element {
  return h(Show, {
    when: props.value,
    children: (value: () => string) =>
      h("div", { "data-slot": "special-message-field" }, [
        h("div", { "data-slot": "special-message-field-label" }, props.label),
        h("div", { "data-slot": "special-message-field-value" }, value()),
      ]),
  }) as unknown as JSX.Element
}

function SourceSessionLink(props: { sessionID: string | undefined }): JSX.Element {
  const data = useData()
  return h(Show, {
    when: props.sessionID,
    children: (sessionID: () => string) =>
      h(
        "button",
        { "data-slot": "special-message-link", onClick: () => data.navigateToSession?.(sessionID()) },
        "Source session",
      ),
  }) as unknown as JSX.Element
}

function WorkflowModeUserRequestMessage(props: SpecialUserMessageProps): JSX.Element {
  const label = createMemo(() => {
    const mode = props.message.metadata?.workflowMode
    if (mode === "plan") return "Plan mode"
    if (mode === "lattice") return "Lattice"
    if (mode === "light_loop") return "Light loop"
    // Legacy back compat
    if (props.message.metadata?.planModeRequest === true) return "Plan mode"
    return "Workflow mode"
  })
  const kind = createMemo(() => {
    const mode = props.message.metadata?.workflowMode
    if (mode === "plan" || props.message.metadata?.planModeRequest === true) return "plan-mode-request"
    if (mode === "lattice") return "lattice-mode-request"
    if (mode === "light_loop") return "light-loop-mode-request"
    return undefined
  })
  return h(
    "div",
    {
      "data-component": "special-user-message",
      "data-kind": kind(),
      "data-layout": "user-bubble",
    },
    [
      h("div", { "data-slot": "special-message-badge" }, label()),
      h(Message, { message: props.message, parts: props.parts, userVariant: "turn-bubble" }),
    ],
  ) as unknown as JSX.Element
}

function HiddenSpecialMessage(): JSX.Element {
  return h("div", {
    "data-component": "special-user-message",
    "data-kind": "hidden",
    hidden: true,
  }) as unknown as JSX.Element
}

function BlueprintControlMessage(props: SpecialUserMessageProps): JSX.Element {
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  let detailsTrigger: HTMLButtonElement | undefined
  const kind = createMemo(() => blueprintDetail(props.message))
  const title = createMemo(() => metadataText(props.message, "title"))
  const loopID = createMemo(() => metadataText(props.message, "loopID"))
  const noteID = createMemo(() => metadataText(props.message, "noteID"))
  const sourceSessionID = createMemo(() => metadataText(props.message, "sourceSessionID"))

  const view = createMemo(() => {
    switch (kind()) {
      case "start":
        return {
          tone: "start",
          icon: "clipboard-list" as IconName,
          eyebrow: "Blueprint",
          heading: "Started execution",
          description: "The execution session is now driving this BlueprintLoop.",
        }
      case "continuation":
        return {
          tone: "continue",
          icon: "refresh-ccw" as IconName,
          eyebrow: "Blueprint",
          heading: "Continued from idle",
          description: "The loop is still running, so the session was asked to inspect progress and continue.",
        }
      case "restart":
        return {
          tone: "restart",
          icon: "clipboard-check" as IconName,
          eyebrow: "Supervisor audit",
          heading: "Changes requested",
          description: "The audit found remaining work and returned the loop to the execution session.",
        }
      default:
        return {
          tone: "default",
          icon: "workflow" as IconName,
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
  const hasRestartDetails = createMemo(() => restartFields().some((field) => !!field.value))

  createEffect(() => {
    detailsTrigger?.setAttribute("aria-expanded", String(detailsOpen()))
  })

  return h(
    "div",
    {
      "data-component": "special-user-message",
      "data-kind": "blueprint",
      "data-layout": "event-card",
      "data-tone": () => view().tone,
    },
    [
      h("div", { "data-slot": "special-message-icon", "aria-hidden": "true" }, [
        h(Icon, { name: () => view().icon, size: "small" }),
      ]),
      h("div", { "data-slot": "special-message-body" }, [
        h("div", { "data-slot": "special-message-header" }, [
          h("div", { "data-slot": "special-message-heading-row" }, [
            h("span", { "data-slot": "special-message-eyebrow" }, () => view().eyebrow),
            h("span", { "data-slot": "special-message-heading" }, () => view().heading),
          ]),
        ]),
        h(Show, {
          when: title(),
          children: (value: () => string) => h("div", { "data-slot": "special-message-title" }, value()),
        }),
        h("div", { "data-slot": "special-message-description" }, () => view().description),
        h("div", { "data-slot": "special-message-meta" }, [
          h(Show, {
            when: loopID(),
            children: (id: () => string) => h("span", {}, ["Loop ", id()]),
          }),
          h(Show, {
            when: noteID(),
            children: (id: () => string) => h("span", {}, ["Note ", id()]),
          }),
          h(SourceSessionLink, { sessionID: sourceSessionID() }),
        ]),
        h(Show, {
          when: userPrompt(),
          children: (prompt: () => string) =>
            h("div", { "data-slot": "special-message-user-prompt" }, [
              h("div", { "data-slot": "special-message-field-label" }, "User instruction"),
              h("div", { "data-slot": "special-message-field-value" }, prompt()),
            ]),
        }),
        h(Show, {
          when: () => kind() === "restart" && hasRestartDetails(),
          children: () => [
            h(
              "button",
              {
                ref: (element: HTMLButtonElement) => {
                  detailsTrigger = element
                },
                type: "button",
                "data-slot": "special-message-details-trigger",
                "aria-expanded": () => detailsOpen(),
                onClick: () => setDetailsOpen((value) => !value),
              },
              [
                h(Show, {
                  when: () => detailsOpen(),
                  fallback: h(Icon, { name: "chevron-right", size: "small" }),
                  children: () => h(Icon, { name: "chevron-down", size: "small" }),
                }),
                h("span", {}, "Details"),
              ],
            ),
            h(Show, {
              when: () => detailsOpen(),
              children: () =>
                h("div", { "data-slot": "special-message-fields" }, [
                  h(For, {
                    each: restartFields(),
                    children: (field: { label: string; value: string | undefined }) =>
                      h(Field, { label: field.label, value: field.value }),
                  }),
                ]),
            }),
          ],
        }),
      ]),
    ],
  ) as unknown as JSX.Element
}

registerSpecialUserMessageRenderer({
  id: "compaction-boundary",
  match(message) {
    return message.metadata?.compactionBoundary === true
  },
  component: HiddenSpecialMessage,
})

registerSpecialUserMessageRenderer({
  id: "workflow-mode-user-request",
  match(message) {
    return (
      (typeof message.metadata?.workflowMode === "string" &&
        ["plan", "lattice", "light_loop"].includes(message.metadata.workflowMode)) ||
      message.metadata?.planModeRequest === true
    )
  },
  component: WorkflowModeUserRequestMessage,
})

registerSpecialUserMessageRenderer({
  id: "blueprint-control",
  match(message) {
    return isBlueprintControl(message)
  },
  component: BlueprintControlMessage,
})
