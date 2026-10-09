import type { AssistantMessage, Message } from "@ericsanchezok/synergy-sdk/client"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import type { I18n } from "@lingui/core"
import { contextWorkspace as C } from "@/locales/messages"
import { isSessionContextUsageBarrier } from "@/context/session-context-usage"

type ProviderCatalog = Record<string, { models?: Record<string, { limit?: ModelLimit.Info } | undefined> } | undefined>
export type ContextStatusPresentation = Record<
  "statusPartiallyKnown" | "statusCompacting" | "statusCompacted" | "statusCritical" | "statusWarning" | "statusReady",
  string
>
export function createContextStatusPresentation(i18n: I18n): ContextStatusPresentation {
  return {
    statusPartiallyKnown: i18n._(C.statusPartiallyKnown),
    statusCompacting: i18n._(C.statusCompacting),
    statusCompacted: i18n._(C.statusCompacted),
    statusCritical: i18n._(C.statusCritical),
    statusWarning: i18n._(C.statusWarning),
    statusReady: i18n._(C.statusReady),
  }
}
export type ContextStatusTone = "neutral" | "warning" | "critical" | "progress"

function latestTokenMessage(messages: Message[]): AssistantMessage | undefined {
  return messages.findLast((message): message is AssistantMessage => {
    if (message.role !== "assistant") return false
    if (message.includeInContext === false) return false
    if (isSessionContextUsageBarrier(message)) return true
    if (message.contextUsage) return true
    const input = ModelLimit.actualInput(message.tokens)
    return input + message.tokens.output > 0
  })
}

export function formatContextNumber(value: number | null | undefined, formatNumber: (value: number) => string): string {
  if (value === null || value === undefined) return "—"
  return formatNumber(value)
}

export function formatContextPercent(
  value: number | null | undefined,
  formatPercent: (value: number) => string,
): string {
  if (value === null || value === undefined) return "—"
  return formatPercent(value / 100)
}

export function buildContextStatusModel(input: {
  messages: Message[]
  latestMessage?: Message | null
  providers: ProviderCatalog
  presentation: ContextStatusPresentation
}) {
  const candidate = input.latestMessage === undefined ? latestTokenMessage(input.messages) : input.latestMessage
  const assistant = candidate?.role === "assistant" ? candidate : undefined
  const compacted = assistant ? isSessionContextUsageBarrier(assistant) : false
  const latest = compacted ? undefined : assistant
  const snapshot = latest?.contextUsage
  const limits = latest ? input.providers[latest.providerID]?.models?.[latest.modelID]?.limit : undefined
  const actual = latest ? ModelLimit.actualInput(latest.tokens) : 0
  const exactInputTokens = snapshot?.totalInput ?? (actual > 0 ? actual : null)
  const capacity = snapshot?.usableInputLimit ?? ModelLimit.usableInput(limits)
  const contextPercentage =
    exactInputTokens !== null && capacity > 0 ? Math.round((exactInputTokens / capacity) * 100) : null
  const compacting = input.messages.some(
    (message) => message.role === "assistant" && message.mode === "compaction" && message.time.completed === undefined,
  )
  let statusSummary = input.presentation.statusPartiallyKnown
  let statusTone: ContextStatusTone = "neutral"
  if (compacting) {
    statusSummary = input.presentation.statusCompacting
    statusTone = "progress"
  } else if (compacted) statusSummary = input.presentation.statusCompacted
  else if (contextPercentage !== null && contextPercentage >= 95) {
    statusSummary = input.presentation.statusCritical
    statusTone = "critical"
  } else if (contextPercentage !== null && contextPercentage >= 80) {
    statusSummary = input.presentation.statusWarning
    statusTone = "warning"
  } else if (contextPercentage !== null) statusSummary = input.presentation.statusReady
  return { statusSummary, statusTone, usage: { exactInputTokens, contextPercentage } }
}
