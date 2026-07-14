import type { IconName } from "../icon"

export const WORKFLOW_TOOL_NAMES = [
  "workflow_status",
  "workflow_run_create",
  "workflow_run_control",
  "workflow_entity_add",
  "workflow_entity_unblock",
  "workflow_gate_resolve",
  "workflow_submit",
  "workflow_block",
  "workflow_charter_draft",
] as const

export interface WorkflowToolInfo {
  icon: IconName
  title: string
  subtitle?: string
  args?: string[]
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function actionTitle(action: unknown) {
  if (typeof action !== "string" || !action) return "Control Workflow Run"
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} Workflow Run`
}

function nestedValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined
  return (value as Record<string, unknown>)[key]
}

export function getWorkflowToolInfo(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): WorkflowToolInfo | undefined {
  const icon: IconName = "workflow"

  switch (tool) {
    case "workflow_status":
      return {
        icon,
        title: "Workflow Status",
        subtitle: firstString(input.entityID, metadata.entityID, metadata.runID),
      }
    case "workflow_run_create":
      return {
        icon,
        title: "Create Workflow Run",
        subtitle: firstString(input.title, metadata.runID),
      }
    case "workflow_run_control":
      return {
        icon,
        title: actionTitle(input.action),
        subtitle: firstString(metadata.runID),
      }
    case "workflow_entity_add":
      return {
        icon,
        title: "Add Workflow Entity",
        subtitle: firstString(input.title, metadata.entityID),
      }
    case "workflow_entity_unblock":
      return {
        icon,
        title: "Unblock Workflow Entity",
        subtitle: firstString(input.entityID, metadata.entityID),
      }
    case "workflow_gate_resolve": {
      const resolution = firstString(input.resolution, metadata.resolution)
      return {
        icon,
        title: "Resolve Workflow Gate",
        subtitle: firstString(input.gateInstanceID, metadata.gateInstanceID),
        args: resolution ? [resolution] : undefined,
      }
    }
    case "workflow_submit": {
      const verdict = firstString(input.verdict)
      return {
        icon,
        title: "Submit Workflow Result",
        subtitle: firstString(input.kind),
        args: verdict ? [verdict] : undefined,
      }
    }
    case "workflow_block":
      return {
        icon,
        title: "Block Workflow Entity",
        subtitle: firstString(input.reason, metadata.entityID),
      }
    case "workflow_charter_draft":
      return {
        icon,
        title: "Draft Workflow Charter",
        subtitle: firstString(input.name, nestedValue(metadata.charterRef, "id")),
        args: input.persist === true ? ["persist"] : undefined,
      }
    default:
      return undefined
  }
}
