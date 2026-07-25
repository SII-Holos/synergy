import type { MessageDescriptor } from "@lingui/core"

function d(id: string, message: string): MessageDescriptor {
  return { id, message }
}

export const COMPACTION_CARD_DESC = {
  runningTitle: /** i18n */ d("ui.compaction.running", "Compressing context..."),
  preparingDescription: /** i18n */ d("ui.compaction.preparing", "Preparing a compact continuation summary"),
  completeTitle: /** i18n */ d("ui.compaction.complete", "Context compressed"),
  summaryReadyDescription: /** i18n */ d("ui.compaction.summaryReady", "Summary ready"),
  failedTitle: /** i18n */ d("ui.compaction.failed", "Compaction failed"),
  failedDescription: /** i18n */ d("ui.compaction.failedDescription", "Unable to compact this session"),
} as const

export type CompactionAttemptState = "running" | "committed" | "failed" | "empty"

export type CompactionCardPresentation = {
  status: "running" | "complete" | "failed"
  title: MessageDescriptor
  description: MessageDescriptor | string
  error?: string
  canExpand: boolean
}

export function compactionErrorText(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined
  if (!error || typeof error !== "object") return undefined
  const value = error as { message?: unknown; data?: unknown }
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim()
  if (!value.data || typeof value.data !== "object") return undefined
  const message = (value.data as { message?: unknown }).message
  return typeof message === "string" && message.trim() ? message.trim() : undefined
}

function errorPreview(error: string): string {
  const line = error
    .replace(/^error:\s*/i, "")
    .split(/\r?\n/)
    .find((item) => item.trim().length > 0)
  return line?.trim() || error
}

export function resolveCompactionCardPresentation(input: {
  attemptState?: CompactionAttemptState
  error?: unknown
  hasRecovery: boolean
  messageCompleted: boolean
  hasSummary: boolean
}): CompactionCardPresentation {
  if (input.attemptState === "failed") {
    const error = compactionErrorText(input.error)
    return {
      status: "failed",
      title: COMPACTION_CARD_DESC.failedTitle,
      description: error ? errorPreview(error) : COMPACTION_CARD_DESC.failedDescription,
      error,
      canExpand: !!error,
    }
  }

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
