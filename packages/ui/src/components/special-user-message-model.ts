import type { Part as PartType, UserMessage } from "@ericsanchezok/synergy-sdk/client"

export interface SpecialUserMessageBubbleView {
  label: string
  kind: string | undefined
  parts: PartType[]
}

interface ProjectedBubbleText {
  label: string
  kind: string | undefined
  text: string
}

const WORKFLOW_CONTROL_SOURCES = new Set(["light_loop_continuation", "lattice_continuation", "lattice_planning_kick"])

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

function workflowLabel(message: UserMessage): string {
  const mode = message.metadata?.workflow
  if (mode === "plan") return "Plan"
  if (mode === "lattice") return "Lattice"
  if (mode === "lightloop") return "Light Loop"
  return "Workflow"
}

function workflowKind(message: UserMessage): string | undefined {
  const mode = message.metadata?.workflow
  if (mode === "plan") return "plan-request"
  if (mode === "lattice") return "lattice-request"
  if (mode === "lightloop") return "lightloop-request"
  return undefined
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
        label: "Blueprint",
        text: userPrompt ?? (title ? `Start Blueprint: ${title}` : "Start Blueprint"),
      }
    }
    case "continuation":
      return {
        label: "Blueprint · Continue",
        text: `${title ? `Continue Blueprint: ${title}` : "Continue this Blueprint."}\n\nCheck progress, keep going if work remains, or send it to audit when complete.`,
      }
    case "rejected":
      return {
        label: "Blueprint · Changes requested",
        text: blueprintRejectionText(message),
      }
    case "completed": {
      const summary = metadataText(message, "summary")
      const base = metadataText(message, "latticeRunID")
        ? "Blueprint step completed. Returning to Lattice result analysis."
        : "Blueprint completed."
      return {
        label: "Blueprint · Completed",
        text: summary ? `${base}\n\nSummary: ${summary}` : base,
      }
    }
    default:
      return {
        label: "Blueprint",
        text: title ? `Blueprint event: ${title}` : "Blueprint event delivered.",
      }
  }
}

function workflowControlView(message: UserMessage): ProjectedBubbleText {
  const source = metadataText(message, "source")
  if (source === "light_loop_continuation") {
    return {
      label: "Light Loop · Continue",
      text: "Continue checking this task. If anything remains, keep going; if it is complete and verified, stop the loop.",
      kind: "lightloop-control",
    }
  }
  if (source === "lattice_continuation") {
    const phase = metadataText(message, "phase")
    return {
      label: "Lattice · Continue",
      text: phase
        ? `Continue the current Lattice path.\n\nCurrent phase: ${phase}`
        : "Continue the current Lattice path. Check the current phase and move to the next step.",
      kind: "lattice-control",
    }
  }
  if (source === "lattice_planning_kick") {
    const goal = metadataText(message, "goal")
    return {
      label: "Lattice",
      text: goal ? `Start planning: ${goal}` : "Start planning the Lattice path.",
      kind: "lattice-control",
    }
  }
  return {
    label: "Workflow",
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
    return {
      label: workflowLabel(message),
      kind: workflowKind(message),
      parts,
    }
  }

  return undefined
}
