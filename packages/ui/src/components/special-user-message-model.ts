import type { Part as PartType, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import type { MessageDescriptor } from "@lingui/core"
import { SPECIAL_USER_LABEL_DESC } from "./tool-title-descriptors"

export interface SpecialUserMessageBubbleView {
  label: MessageDescriptor
  kind: string | undefined
  parts: PartType[]
}

interface ProjectedBubbleText {
  label: MessageDescriptor
  kind: string | undefined
  text: string
}

const WORKFLOW_CONTROL_SOURCES = new Set([
  "light_loop_approved",
  "light_loop_continuation",
  "light_loop_rejected",
  "lattice_continuation",
  "lattice_planning_kick",
])

function metadataText(message: UserMessage, key: string) {
  const value = message.metadata?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function blueprintDetail(message: UserMessage): string | undefined {
  const origin = message.origin
  if (origin?.type === "blueprint") return origin.detail
  const source = message.metadata?.source
  return typeof source === "string" && source.startsWith("blueprint_loop_")
    ? source.slice("blueprint_loop_".length)
    : undefined
}

export function isBlueprintControl(message: UserMessage): boolean {
  return message.origin?.type === "blueprint" || blueprintDetail(message) !== undefined
}

export function isWorkflowControl(message: UserMessage): boolean {
  const source = metadataText(message, "source")
  return source !== undefined && WORKFLOW_CONTROL_SOURCES.has(source)
}

function textPart(message: UserMessage, text: string): PartType {
  return {
    id: `${message.id}_special_display`,
    sessionID: message.sessionID,
    messageID: message.id,
    type: "text",
    text,
  } as PartType
}

function blueprintRejectionText(message: UserMessage): string {
  const reason = metadataText(message, "reason")
  const instructions = metadataText(message, "instructions")
  const remaining = metadataText(message, "remaining")
  const lines = ["Audit requested changes."]
  if (reason) lines.push("", `Reason: ${reason}`)
  if (instructions) lines.push(`Next: ${instructions}`)
  else if (remaining) lines.push(`Remaining: ${remaining}`)
  if (lines.length === 1) lines[0] = "Audit requested changes. Continue from the audit feedback."
  return lines.join("\n")
}

function blueprintBubbleView(message: UserMessage): Omit<ProjectedBubbleText, "kind"> {
  const kind = blueprintDetail(message)
  const title = metadataText(message, "title")
  switch (kind) {
    case "start": {
      const userPrompt = metadataText(message, "userPrompt")
      return {
        label: SPECIAL_USER_LABEL_DESC.blueprint,
        text: userPrompt ?? (title ? `Start Blueprint: ${title}` : "Start Blueprint"),
      }
    }
    case "continuation":
      return {
        label: SPECIAL_USER_LABEL_DESC["blueprint.continue"],
        text: `${title ? `Continue Blueprint: ${title}` : "Continue this Blueprint."}\n\nCheck progress, keep going if work remains, or send it to audit when complete.`,
      }
    case "rejected":
      return {
        label: SPECIAL_USER_LABEL_DESC["blueprint.changes"],
        text: blueprintRejectionText(message),
      }
    case "completed": {
      const summary = metadataText(message, "summary")
      const base = metadataText(message, "latticeRunID")
        ? "Blueprint step completed. Returning to Lattice result analysis."
        : "Blueprint completed."
      return {
        label: SPECIAL_USER_LABEL_DESC["blueprint.completed"],
        text: summary ? `${base}\n\nSummary: ${summary}` : base,
      }
    }
    default:
      return {
        label: SPECIAL_USER_LABEL_DESC.blueprint,
        text: title ? `Blueprint event: ${title}` : "Blueprint event delivered.",
      }
  }
}

function workflowControlView(message: UserMessage): ProjectedBubbleText {
  const source = metadataText(message, "source")
  if (source === "light_loop_continuation") {
    return {
      label: SPECIAL_USER_LABEL_DESC["lightloop.continue"],
      text: "Continue checking this task. If anything remains, keep going; if it is complete and verified, stop the loop.",
      kind: "lightloop-control",
    }
  }
  if (source === "lattice_continuation") {
    const phase = metadataText(message, "phase")
    return {
      label: SPECIAL_USER_LABEL_DESC["lattice.continue"],
      text: phase
        ? `Continue the current Lattice path.\n\nCurrent phase: ${phase}`
        : "Continue the current Lattice path. Check the current phase and move to the next step.",
      kind: "lattice-control",
    }
  }
  if (source === "lattice_planning_kick") {
    const goal = metadataText(message, "goal")
    return {
      label: SPECIAL_USER_LABEL_DESC.lattice,
      text: goal ? `Start planning: ${goal}` : "Start planning the Lattice path.",
      kind: "lattice-control",
    }
  }
  return {
    label: SPECIAL_USER_LABEL_DESC.workflow,
    text: "Continue the workflow.",
    kind: "workflow-control",
  }
}

export function getSpecialUserMessageBubbleView(
  message: UserMessage,
  parts: PartType[],
): SpecialUserMessageBubbleView | undefined {
  if (isBlueprintControl(message)) {
    const view = blueprintBubbleView(message)
    return {
      label: view.label,
      kind: "blueprint-control",
      parts: [textPart(message, view.text)],
    }
  }

  if (isWorkflowControl(message)) {
    const source = metadataText(message, "source")
    if (source === "light_loop_approved" || source === "light_loop_rejected") {
      return {
        label:
          source === "light_loop_approved"
            ? SPECIAL_USER_LABEL_DESC["lightloop.approved"]
            : SPECIAL_USER_LABEL_DESC["lightloop.changes"],
        kind: "lightloop-control",
        parts,
      }
    }

    const view = workflowControlView(message)
    return {
      label: view.label,
      kind: view.kind,
      parts: [textPart(message, view.text)],
    }
  }

  if (
    typeof message.metadata?.workflow === "string" &&
    ["plan", "lattice", "lightloop"].includes(message.metadata.workflow)
  ) {
    const mode = message.metadata?.workflow as string
    const label: MessageDescriptor =
      mode === "plan"
        ? SPECIAL_USER_LABEL_DESC.plan
        : mode === "lattice"
          ? SPECIAL_USER_LABEL_DESC.lattice
          : SPECIAL_USER_LABEL_DESC.lightloop
    return {
      label,
      kind: mode === "plan" ? "plan-request" : mode === "lattice" ? "lattice-request" : "lightloop-request",
      parts,
    }
  }

  return undefined
}
