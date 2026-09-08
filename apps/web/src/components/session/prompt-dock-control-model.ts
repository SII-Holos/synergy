export type PromptDockControl = "workflow_offer" | "session_progress"

export function selectPromptDockControl(input: {
  workflowOfferVisible: boolean
  sessionProgressVisible: boolean
}): PromptDockControl | undefined {
  if (input.workflowOfferVisible) return "workflow_offer"
  if (input.sessionProgressVisible) return "session_progress"
  return undefined
}
