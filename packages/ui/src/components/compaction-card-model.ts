import type { MessageDescriptor } from "@lingui/core"

function d(id: string, message: string): MessageDescriptor {
  return { id, message }
}

export const COMPACTION_CARD_DESC = {
  runningTitle: /** i18n */ d("ui.compaction.running", "Compressing context..."),
  preparingDescription: /** i18n */ d("ui.compaction.preparing", "Preparing a compact continuation summary"),
  completeTitle: /** i18n */ d("ui.compaction.complete", "Context compressed"),
  summaryReadyDescription: /** i18n */ d("ui.compaction.summaryReady", "Summary ready"),
} as const

export type CompactionCardPresentation = {
  status: "running" | "complete"
  title: MessageDescriptor
  description: MessageDescriptor
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
      title: COMPACTION_CARD_DESC.runningTitle,
      description: COMPACTION_CARD_DESC.preparingDescription,
      canExpand: false,
    }
  }

  return {
    status: "complete",
    title: COMPACTION_CARD_DESC.completeTitle,
    description: COMPACTION_CARD_DESC.summaryReadyDescription,
    canExpand: input.hasSummary,
  }
}
