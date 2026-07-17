export type CompactionCardPresentation = {
  status: "running" | "complete"
  title: string
  description: string
  canExpand: boolean
}

export function resolveCompactionCardPresentation(input: {
  hasRecovery: boolean
  messageCompleted: boolean
  hasSummary: boolean
}): CompactionCardPresentation {
  const complete = input.hasRecovery && input.messageCompleted
  if (!complete) {
    return {
      status: "running",
      title: "Compressing context...",
      description: "Preparing a compact continuation summary",
      canExpand: false,
    }
  }

  return {
    status: "complete",
    title: "Context compressed",
    description: "Summary ready",
    canExpand: input.hasSummary,
  }
}
