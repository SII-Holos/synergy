import type { AssistantMessage, Message, Session, SessionStatus, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import type { I18n } from "@lingui/core"
import type { IntlFormatter } from "@/context/locale/formatter"
import { contextWorkspace as C } from "@/locales/messages"
import { isSessionContextUsageBarrier } from "@/context/session-context-usage"

type ProviderCatalog = Record<
  string,
  | {
      name?: string
      models?: Record<string, { name?: string; limit?: ModelLimit.Info } | undefined>
    }
  | undefined
>

type ContextCategoryKey = "conversation" | "toolActivity" | "filesReferences" | "instructions"

export type ContextBreakdownRow = {
  key: ContextCategoryKey | "overhead"
  label: string
  description: string
  estimatedTokens: number | null
  attributedTokens: number
  items: number | null
  percent: number
  estimated: boolean
}

export type ContextPanelPresentation = {
  categoryLabels: Record<ContextCategoryKey, string>
  categoryDescriptions: Record<ContextCategoryKey, string>
  overheadLabel: string
  overheadDescription: string
  statusPartiallyKnown: string
  statusCompacting: string
  statusCompacted: string
  statusCritical: string
  statusWarning: string
  statusReady: string
  untitledSession: string
  formatCurrency: (value: number, currency: string) => string
}

export function createContextPanelPresentation(i18n: I18n, fmt: IntlFormatter): ContextPanelPresentation {
  return {
    categoryLabels: {
      conversation: i18n._(C.categoryConversation),
      toolActivity: i18n._(C.categoryToolActivity),
      filesReferences: i18n._(C.categoryFilesReferences),
      instructions: i18n._(C.categoryInstructions),
    },
    categoryDescriptions: {
      conversation: i18n._(C.categoryConversationDescription),
      toolActivity: i18n._(C.categoryToolActivityDescription),
      filesReferences: i18n._(C.categoryFilesReferencesDescription),
      instructions: i18n._(C.categoryInstructionsDescription),
    },
    overheadLabel: i18n._(C.categoryOverhead),
    overheadDescription: i18n._(C.categoryOverheadDescription),
    statusPartiallyKnown: i18n._(C.statusPartiallyKnown),
    statusCompacting: i18n._(C.statusCompacting),
    statusCompacted: i18n._(C.statusCompacted),
    statusCritical: i18n._(C.statusCritical),
    statusWarning: i18n._(C.statusWarning),
    statusReady: i18n._(C.statusReady),
    untitledSession: i18n._(C.untitledSession),
    formatCurrency: fmt.currency,
  }
}

export type ContextStatusTone = "neutral" | "warning" | "critical" | "progress"

const categoryKeys: ContextCategoryKey[] = ["conversation", "toolActivity", "filesReferences", "instructions"]

function latestTokenMessage(messages: Message[]): AssistantMessage | undefined {
  return messages.findLast((message): message is AssistantMessage => {
    if (message.role !== "assistant") return false
    if (message.includeInContext === false) return false
    if (isSessionContextUsageBarrier(message)) return true
    if (message.contextUsage) return true
    const input = ModelLimit.actualInput(message.tokens)
    return input + message.tokens.output + message.tokens.reasoning > 0
  })
}

function latestUserSystemOverride(messages: Message[]): string | undefined {
  const message = messages.findLast(
    (candidate): candidate is UserMessage =>
      candidate.role === "user" &&
      candidate.isRoot === true &&
      candidate.visible !== false &&
      candidate.includeInContext !== false &&
      Boolean(candidate.system?.trim()),
  )
  return message?.system?.trim() || undefined
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1_000) / 10
}

function cost(value: number | null, presentation: ContextPanelPresentation): string {
  return value === null ? "—" : presentation.formatCurrency(value, "USD")
}

function isCompactionAssistant(message: Message): message is AssistantMessage {
  return message.role === "assistant" && message.mode === "compaction"
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

export function buildContextPanelModel(input: {
  session: Session | undefined
  messages: Message[]
  latestMessage?: Message | null
  providers: ProviderCatalog
  status?: SessionStatus
  pendingItems?: number
  compactRequestPending?: boolean
  presentation: ContextPanelPresentation
}) {
  const projectedLatest = input.latestMessage
  const projectedAssistant =
    projectedLatest === undefined
      ? latestTokenMessage(input.messages)
      : projectedLatest?.role === "assistant"
        ? projectedLatest
        : undefined
  const compacted = projectedAssistant ? isSessionContextUsageBarrier(projectedAssistant) : false
  const latest = compacted ? undefined : projectedAssistant
  const snapshot = latest?.contextUsage
  const sessionModel =
    input.session?.modelOverride ??
    input.messages.findLast(
      (message): message is UserMessage =>
        message.role === "user" && message.isRoot === true && message.model !== undefined,
    )?.model
  const selectedModel = latest
    ? { providerID: latest.providerID, modelID: latest.modelID }
    : compacted
      ? sessionModel
      : undefined
  const provider = selectedModel ? input.providers[selectedModel.providerID] : undefined
  const catalogModel = selectedModel ? provider?.models?.[selectedModel.modelID] : undefined
  const legacyActualInput = latest ? ModelLimit.actualInput(latest.tokens) : 0
  const legacyExactInput = latest && legacyActualInput > 0 ? legacyActualInput : null
  const exactInputTokens = snapshot?.totalInput ?? legacyExactInput
  const outputTokens = latest?.tokens.output ?? null
  const reasoningTokens = latest?.tokens.reasoning ?? null
  const latestCallTotalTokens =
    exactInputTokens !== null && outputTokens !== null && reasoningTokens !== null
      ? exactInputTokens + outputTokens + reasoningTokens
      : null
  const catalogUsableInput = ModelLimit.usableInput(catalogModel?.limit)
  const usableInputLimit = snapshot?.usableInputLimit ?? (catalogUsableInput > 0 ? catalogUsableInput : null)
  const contextWindow = snapshot?.contextLimit ?? catalogModel?.limit?.context ?? null
  const contextPercentage =
    exactInputTokens !== null && usableInputLimit !== null && usableInputLimit > 0
      ? Math.round((exactInputTokens / usableInputLimit) * 100)
      : null
  const remainingInputTokens =
    exactInputTokens !== null && usableInputLimit !== null ? Math.max(0, usableInputLimit - exactInputTokens) : null
  const loadedMessagesCost = input.messages.reduce(
    (sum, message) => sum + (message.role === "assistant" ? message.cost : 0),
    0,
  )
  const effectiveMessages = input.messages.filter((message) => message.includeInContext !== false)
  const userMessages = effectiveMessages.filter((message) => message.role === "user")
  const assistantMessages = effectiveMessages.filter((message) => message.role === "assistant")
  const hasCompressibleHistory = userMessages.some((message) => message.visible !== false)
  const detectedCompaction = input.messages.some(
    (message) => isCompactionAssistant(message) && message.time.completed === undefined,
  )
  const compacting = detectedCompaction || input.compactRequestPending === true
  const sessionPending = (input.status !== undefined && input.status.type !== "idle") || (input.pendingItems ?? 0) > 0
  const compactVisible = contextPercentage !== null && contextPercentage >= 80 && hasCompressibleHistory
  const compactEligible = compactVisible && !compacting && !sessionPending

  let statusSummary = input.presentation.statusPartiallyKnown
  let statusTone: ContextStatusTone = "neutral"
  if (compacting) {
    statusSummary = input.presentation.statusCompacting
    statusTone = "progress"
  } else if (compacted) {
    statusSummary = input.presentation.statusCompacted
  } else if (contextPercentage !== null && contextPercentage >= 95) {
    statusSummary = input.presentation.statusCritical
    statusTone = "critical"
  } else if (contextPercentage !== null && contextPercentage >= 80) {
    statusSummary = input.presentation.statusWarning
    statusTone = "warning"
  } else if (contextPercentage !== null) {
    statusSummary = input.presentation.statusReady
  }

  const breakdownRows: ContextBreakdownRow[] = snapshot
    ? categoryKeys.map((key) => {
        const category = snapshot.categories[key]
        return {
          key,
          label: input.presentation.categoryLabels[key],
          description: input.presentation.categoryDescriptions[key],
          estimatedTokens: category.estimatedTokens,
          attributedTokens: category.attributedTokens,
          items: category.items ?? null,
          percent: percentage(category.attributedTokens, snapshot.totalInput),
          estimated: true,
        }
      })
    : []
  if (snapshot && snapshot.overhead.attributedTokens > 0) {
    breakdownRows.push({
      key: "overhead",
      label: input.presentation.overheadLabel,
      description: input.presentation.overheadDescription,
      estimatedTokens: null,
      attributedTokens: snapshot.overhead.attributedTokens,
      items: null,
      percent: percentage(snapshot.overhead.attributedTokens, snapshot.totalInput),
      estimated: false,
    })
  }
  const rawEstimatedTotal = snapshot
    ? Object.values(snapshot.categories).reduce((sum, category) => sum + category.estimatedTokens, 0)
    : null
  const attributedTotal = snapshot
    ? Object.values(snapshot.categories).reduce((sum, category) => sum + category.attributedTokens, 0) +
      snapshot.overhead.attributedTokens
    : null

  return {
    latest,
    providerLabel: selectedModel ? provider?.name || selectedModel.providerID : "—",
    modelLabel: selectedModel ? catalogModel?.name || selectedModel.modelID : "—",
    latestUserSystemOverride: latestUserSystemOverride(input.messages),
    statusSummary,
    statusTone,
    breakdownAvailable: Boolean(snapshot),
    breakdownRows,
    compact: {
      visible: compactVisible,
      eligible: compactEligible,
      pending: input.compactRequestPending === true,
      inProgress: compacting,
      hasCompressibleHistory,
    },
    usage: {
      exactInputTokens,
      outputTokens,
      reasoningTokens,
      latestCallTotalTokens,
      contextPercentage,
      contextWindow,
      usableInputLimit,
      remainingInputTokens,
      latestCallCost: cost(latest?.cost ?? null, input.presentation),
      loadedMessagesCost: cost(
        input.messages.some((message) => message.role === "assistant") ? loadedMessagesCost : null,
        input.presentation,
      ),
      cacheReadTokens: latest?.tokens.cache.read ?? null,
      cacheWriteTokens: latest?.tokens.cache.write ?? null,
    },
    developerDetails: {
      title: input.session?.title ?? input.presentation.untitledSession,
      sessionID: input.session?.id ?? latest?.sessionID ?? "—",
      effectiveMessages: effectiveMessages.length,
      effectiveUserMessages: userMessages.length,
      effectiveAssistantMessages: assistantMessages.length,
      createdAt: input.session?.time.created,
      updatedAt: input.session?.time.updated,
      estimatorKind: snapshot?.estimator.kind ?? null,
      estimatorEncoding: snapshot?.estimator.encoding ?? null,
      reconciliationMode: snapshot?.reconciliation.mode ?? null,
      reconciliationFactor: snapshot?.reconciliation.factor ?? null,
      rawEstimatedTotal,
      attributedTotal,
    },
  }
}
