import { useLingui } from "@lingui/solid"
import { SESSION_TURN_DESC, MAILBOX_DESC, TOOL_LABEL_DESC } from "./tool-title-descriptors"

import type {
  AssistantMessage,
  AttachmentPart,
  Message as MessageType,
  Part as PartType,
  PermissionRequest,
  ReasoningPart,
  SessionStatus,
  TextPart,
  ToolPart,
  UserMessage,
} from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"

import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  mapArray,
  Match,
  on,
  onCleanup,
  ParentProps,
  Show,
  Switch,
} from "solid-js"
import type { Accessor } from "solid-js"
import type { PluginConversationActivityView } from "@ericsanchezok/synergy-plugin"
import { ActivityBatch } from "./activity-batch"
import { ActivityReasoning } from "./process-reasoning"
import { createDisclosureMotionRef } from "../utils/disclosure-motion"
import { projectActivityBatches, resolveActivityDisclosure } from "./session-turn-process"
export { resolveActivityDisclosure } from "./session-turn-process"
import { TurnChangeSummaryPanel } from "./turn-change-summary-panel"
import {
  resolveTurnDiffPanelState,
  TURN_DIFF_PENDING_DELAY_MS,
  type TurnDiffPanelState,
} from "./turn-change-summary-panel-model"
import { Message, Part, getToolInfo } from "./message-part"
import { MessageSlotOutlet, type MessageSlotName } from "./message-slots"
import { AttachmentGallery } from "./attachment-card"
import { attachmentSize, formatAttachmentSize, resolveAttachmentPresentation } from "./attachment-card-utils"
import { BasicTool } from "./basic-tool"
import { classifyTool } from "./tool/classifier"
import { MediaGenerationCard } from "./media-generation-card"
import {
  isActiveMediaGenerationToolPart,
  isMediaGenerationToolPart,
  isToolCardHidden,
} from "./tool-result-presentation"
import { isSpeakTool, noteSpeakPartActive } from "./session-turn-speak-autoplay"
import "./session-turn.css"
import "./tool-renders"
import { Icon } from "./icon"
import { getSemanticIcon, type SemanticIconTokenName } from "./semantic-icon"
import { ErrorCard } from "./error-card"
import { Dynamic } from "solid-js/web"
import { createAutoScroll } from "../hooks"
import { getSpecialUserMessageRenderer } from "./special-user-message"
import { CompactionCard } from "./compaction-card"
import { createCopyController } from "./clipboard"
import { hasVisibleUserMessageContent, isSystemPart } from "./user-message-utils"
import { ActivityReceipt, ActivityTrace } from "./activity-trace"
import { CompactReasoningLine } from "./compact-reasoning"
import {
  activityItemStableKey,
  isActivityTimelineItem,
  projectAssistantActivityItems,
  resolveActivityDisplay,
  type ActivityDisplayMode,
  type ActivityTimelineItem,
} from "./session-turn-activity"
import { timelineItemStableKey, timelineVisualKind, type SessionTurnTimelineItem } from "./session-turn-timeline-item"
import { ExecutionCompletion, type TurnExecutionSummary } from "./execution-completion"
import { externalLoadNotify, externalLookup, resolveExternalToolRenderer } from "./tool-registry-lazy"
export { timelineItemStableKey, timelineVisualKind } from "./session-turn-timeline-item"
export type { SessionTurnTimelineItem, SessionTurnTimelineVisualKind } from "./session-turn-timeline-item"

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export type TurnCompletionStats = {
  duration: string
  segments: string[]
}

export function providerPreludeElapsedLabel(started: number | undefined, now: number): string | undefined {
  if (started == null) return undefined

  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const mm = minutes.toString().padStart(2, "0")
  const ss = seconds.toString().padStart(2, "0")

  if (hours > 0) return `${hours}:${mm}:${ss}`
  return `${mm}:${ss}`
}

export function formatTurnTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 10_000) return `${Number((value / 1_000).toFixed(1))}k`
  return value.toLocaleString()
}

const turnCostByLocale = new Map<string, Intl.NumberFormat>()

function turnCostFormatter(locale: string | undefined): Intl.NumberFormat {
  const key = locale ?? ""
  const cached = turnCostByLocale.get(key)
  if (cached) return cached
  const created = new Intl.NumberFormat(locale ? [locale] : undefined, {
    style: "currency",
    currency: "USD",
  })
  turnCostByLocale.set(key, created)
  return created
}

export function formatTurnCost(value: number, locale?: string): string | undefined {
  if (value <= 0) return undefined
  if (value < 0.01) return `$${value.toFixed(4)}`
  return turnCostFormatter(locale).format(value)
}
export function resolveSessionTurnError(value: NonNullable<AssistantMessage["error"]>) {
  if (value.name === "ProviderModelUnavailableError") {
    return {
      kind: "model-unavailable" as const,
      descriptor: SESSION_TURN_DESC.modelUnavailable,
      values: { modelID: value.data.modelID, providerID: value.data.providerID },
    }
  }
  if (value.name === "ProviderModelVariantUnavailableError") {
    const availableVariants = value.data.availableVariants.join(", ")
    return {
      kind: "model-variant-unavailable" as const,
      descriptor: SESSION_TURN_DESC.modelVariantUnavailable,
      values: {
        providerID: value.data.providerID,
        modelID: value.data.modelID,
        variant: value.data.variant,
        availability: availableVariants ? "available" : "none",
        availableVariants,
      },
    }
  }
  if ("message" in value.data && typeof value.data.message === "string") {
    return { kind: "message" as const, message: value.data.message }
  }
}

export function turnCompletionStats(
  messages: readonly AssistantMessage[],
  locale?: string,
): TurnCompletionStats | undefined {
  const completed = messages.filter((message) => message.time.completed != null)
  if (completed.length === 0 || completed.length !== messages.length) return undefined

  const firstStarted = completed.reduce<number | undefined>((earliest, message) => {
    if (message.time.created == null) return earliest
    if (earliest == null || message.time.created < earliest) return message.time.created
    return earliest
  }, undefined)
  const lastCompleted = completed.reduce<number | undefined>((latest, message) => {
    if (message.time.completed == null) return latest
    if (latest == null || message.time.completed > latest) return message.time.completed
    return latest
  }, undefined)
  const duration = lastCompleted == null ? undefined : providerPreludeElapsedLabel(firstStarted, lastCompleted)
  if (!duration) return undefined

  const totals = completed.reduce(
    (sum, message) => {
      const tokens = message.tokens
      if (tokens) {
        sum.input += tokens.input
        sum.output += tokens.output
        sum.reasoning += tokens.reasoning
        sum.cacheRead += tokens.cache.read
        sum.cacheWrite += tokens.cache.write
      }
      sum.cost += message.cost ?? 0
      return sum
    },
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )

  const segments: string[] = []
  if (totals.input > 0) segments.push(`${formatTurnTokenCount(totals.input)} input`)
  if (totals.cacheRead > 0) segments.push(`${formatTurnTokenCount(totals.cacheRead)} cache read`)
  if (totals.cacheWrite > 0) segments.push(`${formatTurnTokenCount(totals.cacheWrite)} cache write`)
  if (totals.output > 0) segments.push(`${formatTurnTokenCount(totals.output)} output`)
  if (totals.reasoning > 0) segments.push(`${formatTurnTokenCount(totals.reasoning)} reasoning`)
  const cost = formatTurnCost(totals.cost, locale)
  if (cost) segments.push(cost)

  return { duration, segments }
}

function visibleAttachmentParts(files: AttachmentPart[] | undefined): AttachmentPart[] {
  return (files ?? []).filter((file) => !resolveAttachmentPresentation(file).hidden)
}

function isCompactionAssistant(message: AssistantMessage): boolean {
  return message.mode === "compaction" || message.agent === "compaction"
}

function isProjectedCompactionAttempt(message: AssistantMessage): boolean {
  if (!isCompactionAssistant(message)) return false
  const attempt = message.metadata?.compactionAttempt as { state?: unknown } | undefined
  return attempt?.state === "running" || attempt?.state === "failed"
}

export function isCompactionBoundaryUser(message: Pick<UserMessage, "metadata">): boolean {
  return message.metadata?.compactionBoundary === true
}

export function collectCompactionParentIDs(messages: readonly MessageType[]): Set<string> {
  const result = new Set<string>()
  for (const message of messages) {
    if (message.role !== "user") continue
    const metadata = (message as UserMessage).metadata
    const parentID = metadata?.compactionParentID
    if (metadata?.compactionBoundary === true && typeof parentID === "string" && parentID) result.add(parentID)
  }
  return result
}

export function collectUserCompactionTimelineItems(
  message: UserMessage,
  parts: readonly PartType[],
): SessionTurnTimelineItem[] {
  const compactionRecovery = parts.find((part) => part.type === "compaction_recovery")
  if (compactionRecovery) return [{ kind: "compaction", message, part: compactionRecovery }]

  if (!isCompactionBoundaryUser(message)) return []

  const compactionRequest = parts.find((part) => part.type === "compaction")
  if (!compactionRequest) return []

  return [{ kind: "compaction", message, part: compactionRequest }]
}

export function shouldShowTurnDiffs(
  message: Pick<UserMessage, "metadata" | "summary"> | undefined,
  options: { hasCompactionEvent?: boolean; isCompactedParent?: boolean } = {},
): TurnDiffPanelState {
  if (!message) return "hidden"
  if (options.isCompactedParent) return "hidden"
  if (isCompactionBoundaryUser(message) || options.hasCompactionEvent) return "hidden"

  const summary = message.summary
  const diffState = summary?.diffState
  if (!diffState) return (summary?.diffs.length ?? 0) > 0 ? "ready" : "hidden"
  if (diffState.status === "pending") return "pending"
  if (diffState.status === "error") return "error"
  if (diffState.status === "partial") return "partial"
  return summary.diffs.length > 0 ? "ready" : "hidden"
}

export function shouldShowTurnUserChrome(
  message: Pick<UserMessage, "metadata" | "visible"> | undefined,
  parts: readonly PartType[] | undefined,
  hasCompactionEvent: boolean,
): boolean {
  if (!message) return false
  if (isCompactionBoundaryUser(message)) return false
  if (!hasCompactionEvent) return true
  if (message.visible === false) return false

  return hasVisibleUserMessageContent(parts)
}

export function timelineKindForPart(part: PartType, _working: boolean): SessionTurnTimelineItem["kind"] | undefined {
  if (part.type === "text") return part.text.trim() ? "part" : undefined
  if (part.type === "attachment") return resolveAttachmentPresentation(part).hidden ? undefined : "part"
  if (part.type === "reasoning") return part.text.trim() ? "reasoning" : undefined
  if (part.type === "compaction_recovery") return "part"
  if (part.type !== "tool") return undefined
  if (isActiveMediaGenerationToolPart(part)) return "media-pending"
  if (isToolCardHidden(part)) {
    if (part.state.status === "error") return "part"
    if (part.state.status !== "completed") return undefined
    return visibleAttachmentParts(part.state.attachments).length > 0 ? "tool-attachments" : undefined
  }
  return "part"
}

export function collectSessionTurnTimelineItems(
  messages: AssistantMessage[],
  partsByMessage: Record<string, PartType[] | undefined>,
  working: boolean,
): SessionTurnTimelineItem[] {
  const items: SessionTurnTimelineItem[] = []

  for (const message of messages) {
    const parts = partsByMessage[message.id] ?? []
    const compactionRecovery = parts.find((part) => part.type === "compaction_recovery")
    if (isCompactionAssistant(message)) {
      items.push({ kind: "compaction", message, part: compactionRecovery })
      continue
    }

    const msgStartIndex = items.length
    const hasCompactionRecovery = !!compactionRecovery
    for (const part of parts) {
      const kind = timelineKindForPart(part, working)
      if (!kind) continue

      // When a compaction recovery card is present, suppress raw text parts
      // so only the structured card renders — no duplicate markdown output.
      if (hasCompactionRecovery && part.type === "text") continue

      if (kind === "media-pending") {
        items.push({ kind, message, part: part as ToolPart })
        continue
      }

      if (kind === "tool-attachments") {
        const toolPart = part as ToolPart
        const files = toolPart.state.status === "completed" ? visibleAttachmentParts(toolPart.state.attachments) : []
        if (files.length === 0) continue
        items.push({ kind, message, part: toolPart, files })
        continue
      }

      if (kind === "reasoning") {
        items.push({ kind, message, part: part as ReasoningPart })
        continue
      }

      items.push({ kind, message, part: part as TextPart | ToolPart | AttachmentPart })
    }

    // When the turn is complete, hide reasoning items if there are visible
    // text/tool/attachment items (standard behavior: final output supersedes
    // thinking tokens). When there are no visible items — reasoning-only
    // response — promote reasoning to "part" so content is not lost.
    if (!working) {
      const msgItems = items.slice(msgStartIndex)
      const hasVisiblePart = msgItems.some((item) => item.kind !== "reasoning" && item.kind !== "compaction")
      if (hasVisiblePart) {
        // Remove reasoning items (thought tokens hidden by real output)
        for (let i = items.length - 1; i >= msgStartIndex; i--) {
          if (items[i]?.kind === "reasoning") items.splice(i, 1)
        }
      } else {
        // Promote reasoning items to "part" so they display as text
        for (let i = msgStartIndex; i < items.length; i++) {
          if (items[i]?.kind === "reasoning") {
            items[i] = {
              kind: "part",
              message: items[i].message,
              part: items[i].part,
            } as SessionTurnTimelineItem
          }
        }
      }
    }
  }

  return items
}

export function compactReasoningTimelineItems<T extends { kind: string }>(items: readonly T[]): T[] {
  const latestReasoning = items.findLastIndex((item) => item.kind === "reasoning")
  if (latestReasoning < 0) return [...items]
  return items.filter((item, index) => item.kind !== "reasoning" || index === latestReasoning)
}

export { compactReasoningText } from "./compact-reasoning-text"
/** A non-root, visible user message rendered as an inline chip inside its turn. */
export function isGuidedContextUserMessage(message: Pick<UserMessage, "isRoot" | "visible">): boolean {
  return message.isRoot === false && message.visible !== false
}

export type SessionTurnDisplayMessage = AssistantMessage | UserMessage

function chipLabelFromOrigin(origin: { type: string; label?: string; detail?: string } | undefined): string {
  if (!origin || !origin.type) return "Guided"
  if (origin.label) return origin.label
  switch (origin.type) {
    case "cortex":
      return "Agent"
    case "agenda":
      return "Agenda"
    case "blueprint":
      return "Blueprint"
    case "channel":
      return "Channel"
    case "agent":
      return "Forwarded"
    case "compaction":
      return "Compaction"
    case "plugin":
      return "Plugin"
    case "system":
      return "System"
    default:
      return "Guided"
  }
}

function findMessageIndex(messages: readonly MessageType[], messageID: string) {
  return messages.findIndex((message) => message.id === messageID)
}

export function collectMessagesForTurnLifecycle(
  messages: MessageType[],
  userMessageID: string,
): SessionTurnDisplayMessage[] {
  const userMessageIndex = findMessageIndex(messages, userMessageID)
  if (userMessageIndex === -1) return []

  const userMessage = messages[userMessageIndex]
  if (!userMessage || userMessage.role !== "user") return []

  const user = userMessage as UserMessage
  // Canonicalized on the backend read path; self-reference as a defensive default.
  const rootID = user.rootID ?? user.id

  const result: SessionTurnDisplayMessage[] = []

  // Collect every message belonging to this task (matching rootID), skipping —
  // not stopping at — messages from other tasks. Tasks can interleave: a queued
  // task root pre-allocates its message id, so a still-running earlier task can
  // emit assistants whose ids fall after this root but before this task's own
  // replies. Breaking on the first foreign message would drop those replies.
  for (let i = userMessageIndex + 1; i < messages.length; i++) {
    const item = messages[i]
    if (!item || item.rootID !== rootID) continue

    if (item.role === "user" && (item as UserMessage).isRoot) continue
    result.push(item as SessionTurnDisplayMessage)
  }

  return result
}

function filterMessagesForTurnDisplay(messages: readonly SessionTurnDisplayMessage[]): SessionTurnDisplayMessage[] {
  return messages.filter((message) => {
    if ((message as { visible?: boolean }).visible !== false) return true
    return message.role === "assistant" && isProjectedCompactionAttempt(message as AssistantMessage)
  })
}

export function collectMessagesForTurnDisplay(
  messages: MessageType[],
  userMessageID: string,
): SessionTurnDisplayMessage[] {
  return filterMessagesForTurnDisplay(collectMessagesForTurnLifecycle(messages, userMessageID))
}

export function collectAssistantMessagesForTurn(messages: MessageType[], userMessageID: string): AssistantMessage[] {
  return collectMessagesForTurnDisplay(messages, userMessageID).filter(
    (message): message is AssistantMessage => message.role === "assistant",
  )
}

function isTerminalAssistant(message: AssistantMessage): boolean {
  return !!message.finish && message.finish !== "tool-calls" && message.finish !== "unknown"
}

export function resolveTurnWorking(input: {
  isLastUserMessage: boolean
  messages: readonly SessionTurnDisplayMessage[]
  sessionStatus?: SessionStatus
}): boolean {
  if (!input.isLastUserMessage) return false
  if (input.sessionStatus?.type === "paused") return false

  let latestUserIndex = -1
  let lastAssistant: AssistantMessage | undefined
  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index]
    if (message.role === "user") {
      latestUserIndex = index
      continue
    }
    lastAssistant = message
  }

  const hasTerminalReply = input.messages.slice(latestUserIndex + 1).some((message) => {
    return message.role === "assistant" && isTerminalAssistant(message)
  })
  if (hasTerminalReply) return false

  if (lastAssistant?.time.completed == null) return !!input.sessionStatus && input.sessionStatus.type !== "idle"
  return !!input.sessionStatus && input.sessionStatus.type !== "idle"
}

const awaitingResponse = { id: "ui.session.awaitingResponse", message: "Awaiting response…" }

export function providerPreludeText(status: SessionStatus | undefined, fallback = awaitingResponse.message): string {
  if (status?.type === "busy") {
    const description = status.description?.trim()
    if (description) return description
  }
  return fallback
}

export function shouldShowProviderPrelude(input: {
  working: boolean
  hasError: boolean
  latestAssistant?: AssistantMessage
  latestAssistantTimelineItems: readonly (SessionTurnTimelineItem | ActivityTimelineItem)[]
  hasTurnContent?: boolean
}): boolean {
  if (!input.working || input.hasError || input.hasTurnContent) return false
  if (!input.latestAssistant) return true
  if (input.latestAssistant.time.completed != null) return false
  return input.latestAssistantTimelineItems.length === 0
}

function TimelineItemDisplay(props: {
  item: SessionTurnTimelineItem
  serverUrl: string
  working?: boolean
  compactReasoning?: boolean
  activityDisplay?: ActivityDisplayMode
  activityView?: PluginConversationActivityView
  activeBatch?: string
  following?: boolean
  onInspectProcess?: () => void
  initialReasoning?: boolean
}) {
  const running = createMemo(() => {
    if (props.item.kind !== "reasoning") return false
    return props.working === true && props.item.message.time.completed == null && props.item.part.time?.end == null
  })
  if (props.item.kind === "compaction") {
    return <CompactionCard part={props.item.part} message={props.item.message} />
  }
  if (props.item.kind === "reasoning" && props.compactReasoning) {
    return <CompactReasoningLine fullText={props.item.part.text} running={running()} />
  }
  if (props.item.kind === "part" || props.item.kind === "reasoning") {
    return <Part part={props.item.part} message={props.item.message} />
  }
  if (props.item.kind === "media-pending") {
    // Watch speak parts stream in: when the same part later completes, its
    // audio autoplays once. Non-speak media (images/video) stays silent.
    const pendingPart = props.item.part
    if (pendingPart.type === "tool" && isSpeakTool(pendingPart.tool)) {
      noteSpeakPartActive(`speak:${pendingPart.id}`)
    }
    return <MediaGenerationCard part={pendingPart} />
  }
  if (isMediaGenerationToolPart(props.item.part)) {
    // Completed media-generation tool part. speak delivers speech the agent
    // decided to announce: the audio autoplays on its fresh card and keeps
    // playing across the settlement re-projection (the tracker qualification
    // is sticky until the clip ends or the user pauses). History replay and
    // re-renders of an already finished clip stay silent.
    const part = props.item.part
    const tool = part.type === "tool" ? part.tool : ""
    const autoplay = isSpeakTool(tool)
    return (
      <AttachmentGallery
        files={props.item.files}
        serverUrl={props.serverUrl}
        autoplay={autoplay}
        autoplayKey={autoplay ? `speak:${part.id}` : undefined}
      />
    )
  }
  return <DeliveredAttachmentsCard item={props.item} serverUrl={props.serverUrl} />
}

function DeliveredAttachmentsCard(props: {
  item: Extract<SessionTurnTimelineItem, { kind: "tool-attachments" }>
  serverUrl: string
}) {
  const { _ } = useLingui()
  const part = () => props.item.part
  const files = () => props.item.files
  const input = () => (part().state.input ?? {}) as Record<string, unknown>
  const metadata = () => (part().state.metadata ?? {}) as Record<string, unknown>
  const trigger = () => {
    const info = getToolInfo(part().tool, input(), metadata())
    if (typeof info.title === "string" && info.title === part().tool) {
      const classified = classifyTool(part().tool, input(), metadata())
      return { icon: classified.spec.icon, title: classified.title }
    }
    return { icon: info.icon, title: info.title }
  }
  const subtitle = () => {
    const current = files()
    return current.length === 1
      ? current[0].filename
      : _({ ...TOOL_LABEL_DESC.files, values: { count: current.length } })
  }
  const totalBytes = () => files().reduce((sum, file) => sum + (attachmentSize(file) ?? 0), 0)
  const tags = () => {
    const bytes = totalBytes()
    const label = bytes > 0 ? formatAttachmentSize(bytes) : undefined
    return label ? [{ label }] : undefined
  }
  return (
    <BasicTool defaultOpen trigger={{ ...trigger(), subtitle: subtitle(), tags: tags() }}>
      <AttachmentGallery files={files()} serverUrl={props.serverUrl} />
    </BasicTool>
  )
}

function isToolTimelineItem(item: SessionTurnTimelineItem): boolean {
  const kind = timelineVisualKind(item)
  return kind === "tool" || kind === "media-pending" || kind === "tool-attachments"
}

type SessionTurnAssistantDisplayItem = SessionTurnTimelineItem | ActivityTimelineItem

type SessionTurnDisplayItem =
  | SessionTurnAssistantDisplayItem
  | {
      kind: "guided-user"
      message: UserMessage
      parts: PartType[]
    }
  | {
      kind: "non-root-user"
      message: UserMessage
      parts: PartType[]
      originLabel: string
    }

function isAssistantTimelineDisplayItem(item: SessionTurnDisplayItem): item is SessionTurnAssistantDisplayItem {
  return item.kind !== "guided-user" && item.kind !== "non-root-user"
}

function displayItemTimelineItem(item: SessionTurnAssistantDisplayItem): SessionTurnTimelineItem | undefined {
  if (!isActivityTimelineItem(item)) return item
  return item.kind === "passthrough" ? item.item : undefined
}

function displayItemStableKey(item: SessionTurnDisplayItem): string {
  if (item.kind === "guided-user") return `guided-user:${item.message.id}`
  if (item.kind === "non-root-user") return `non-root-user:${item.message.id}`
  if (isActivityTimelineItem(item)) return activityItemStableKey(item)
  return timelineItemStableKey(item)
}

function isActivityBoundaryDisplayItem(item: SessionTurnDisplayItem): boolean {
  return isActivityTimelineItem(item) && item.kind === "activity-boundary"
}

function displayItemVisualKind(item: SessionTurnDisplayItem) {
  if (item.kind === "guided-user") return "guided-user"
  if (item.kind === "non-root-user") return "non-root-user"
  if (isActivityTimelineItem(item)) {
    if (item.kind === "passthrough") return timelineVisualKind(item.item)
    return item.kind
  }
  return timelineVisualKind(item)
}

function adjacentActivityGroup(
  keys: readonly string[],
  map: ReadonlyMap<string, SessionTurnDisplayItem>,
  index: number,
  direction: -1 | 1,
): boolean {
  const current = map.get(keys[index])
  if (!current || !isActivityTimelineItem(current) || current.kind !== "activity-group") return false
  for (
    let adjacentIndex = index + direction;
    adjacentIndex >= 0 && adjacentIndex < keys.length;
    adjacentIndex += direction
  ) {
    const adjacent = map.get(keys[adjacentIndex])
    if (!adjacent || isActivityBoundaryDisplayItem(adjacent)) continue
    return isActivityTimelineItem(adjacent) && adjacent.kind === "activity-group"
  }
  return false
}

function isReasoningDisplayItem(item: SessionTurnDisplayItem): boolean {
  if (!isAssistantTimelineDisplayItem(item)) return false
  if (isActivityTimelineItem(item) && item.kind === "activity-reasoning-summary") return true
  if (item.kind === "activity-batch") return item.entries?.some((entry) => entry.kind === "reasoning") ?? false
  return displayItemTimelineItem(item)?.kind === "reasoning"
}

function isToolRegionDisplayItem(item: SessionTurnDisplayItem): boolean {
  if (!isAssistantTimelineDisplayItem(item)) return false
  if (isActivityTimelineItem(item)) {
    return (
      item.kind === "activity-batch" ||
      item.kind === "activity-group" ||
      item.kind === "activity-summary" ||
      item.kind === "activity-receipt"
    )
  }
  return isToolTimelineItem(item)
}

function isCompactionDisplayItem(item: SessionTurnDisplayItem): boolean {
  if (!isAssistantTimelineDisplayItem(item)) return false
  const timelineItem = displayItemTimelineItem(item)
  return timelineItem ? timelineVisualKind(timelineItem) === "compaction" : false
}

function persistedReasoningRow(entry: { message: AssistantMessage; part: ReasoningPart }): SessionTurnDisplayItem {
  return {
    kind: "passthrough",
    item: { kind: "reasoning", message: entry.message, part: entry.part },
    message: entry.message,
  }
}

export function injectPersistedReasoningItems(
  items: readonly SessionTurnDisplayItem[],
  assistants: readonly AssistantMessage[],
  partsByMessage: Record<string, PartType[] | undefined>,
): SessionTurnDisplayItem[] {
  const persisted = new Map<string, { message: AssistantMessage; part: ReasoningPart }>()
  const partPositions = new Map<string, number>()
  for (const assistant of assistants) {
    const parts = partsByMessage[assistant.id] ?? []
    parts.forEach((part, index) => partPositions.set(part.id, index))
    const part = parts.findLast(
      (candidate): candidate is ReasoningPart => candidate.type === "reasoning" && Boolean(candidate.text.trim()),
    )
    if (part) persisted.set(assistant.id, { message: assistant, part })
  }
  if (persisted.size === 0) return [...items]

  const itemPartPosition = (item: SessionTurnDisplayItem): number | undefined => {
    if (!isAssistantTimelineDisplayItem(item)) return undefined
    if (isActivityTimelineItem(item)) {
      if (item.kind === "activity-reasoning-summary") return partPositions.get(item.partID)
      if (item.kind === "activity-group" || item.kind === "activity-receipt") {
        const steps = item.kind === "activity-group" ? item.steps : item.group.steps
        let position: number | undefined
        for (const step of steps) {
          const candidate = partPositions.get(step.part.id)
          if (candidate === undefined) continue
          position = position === undefined ? candidate : Math.min(position, candidate)
        }
        return position
      }
      if (item.kind === "passthrough") {
        const part = item.item.part
        return part ? partPositions.get(part.id) : undefined
      }
      return undefined
    }
    return item.part ? partPositions.get(item.part.id) : undefined
  }

  const isPromotedReasoningPart = (item: SessionTurnDisplayItem): boolean => {
    if (!isAssistantTimelineDisplayItem(item) || isActivityTimelineItem(item)) return false
    return item.kind === "part" && item.part.type === "reasoning"
  }

  const lastIndexByMessage = new Map<string, number>()
  items.forEach((item, index) => lastIndexByMessage.set(item.message.id, index))

  // Reasoning-representing items are replaced by the compact row: the root
  // reasoning summary (balanced fallback) yields to the row in place, the
  // latest promoted reasoning part yields to the row at its part position,
  // and any earlier reasoning part is dropped.
  const result: SessionTurnDisplayItem[] = []
  const inserted = new Set<string>()
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const entry = persisted.get(item.message.id)
    if (!entry) {
      result.push(item)
      continue
    }
    if (inserted.has(item.message.id)) {
      if (!isReasoningDisplayItem(item) && !isPromotedReasoningPart(item)) result.push(item)
      continue
    }
    if (isReasoningDisplayItem(item) || isPromotedReasoningPart(item)) {
      const isSummary = isActivityTimelineItem(item) && item.kind === "activity-reasoning-summary"
      if (isSummary || itemPartPosition(item) === partPositions.get(entry.part.id)) {
        result.push(persistedReasoningRow(entry))
        inserted.add(item.message.id)
      }
    } else {
      const itemPosition = itemPartPosition(item)
      const reasoningPosition = partPositions.get(entry.part.id)
      if (itemPosition !== undefined && reasoningPosition !== undefined && itemPosition > reasoningPosition) {
        result.push(persistedReasoningRow(entry))
        inserted.add(item.message.id)
      }
      result.push(item)
    }
    if (index === lastIndexByMessage.get(item.message.id) && !inserted.has(item.message.id)) {
      result.push(persistedReasoningRow(entry))
      inserted.add(item.message.id)
    }
  }
  for (const entry of persisted.values()) {
    if (inserted.has(entry.message.id)) continue
    result.push(persistedReasoningRow(entry))
  }
  return result
}

function originIconToken(origin: { type: string; label?: string; detail?: string } | undefined): SemanticIconTokenName {
  if (!origin || !origin.type) return "session.default"
  switch (origin.type) {
    case "cortex":
      return "cortex.main"
    case "agenda":
      return "session.background"
    case "blueprint":
      return "blueprint.main"
    case "channel":
      return "channels.main"
    case "agent":
      return "prompt.submit"
    case "compaction":
      return "settings.compaction"
    case "plugin":
      return "plugins.main"
    case "system":
      return "settings.models"
    default:
      return "session.default"
  }
}

export function TimelineDisplay(props: {
  item: SessionTurnDisplayItem
  serverUrl: string
  rollbackActive: boolean
  onRewind?: () => void
  working: boolean
  compactReasoning?: boolean
  activityDisplay?: ActivityDisplayMode
  activityView?: PluginConversationActivityView
  activeBatch?: string
  following?: boolean
  onInspectProcess?: () => void
  initialReasoning?: boolean
}) {
  return (
    <ErrorBoundary
      fallback={(err) => (
        <div data-slot="session-turn-timeline-item-error">
          <ErrorCard error={err?.message || String(err)} />
        </div>
      )}
    >
      <TimelineDisplayInner {...props} />
    </ErrorBoundary>
  )
}

function TimelineDisplayInner(props: {
  item: SessionTurnDisplayItem
  serverUrl: string
  rollbackActive: boolean
  onRewind?: () => void
  working: boolean
  compactReasoning?: boolean
  activityDisplay?: ActivityDisplayMode
  activityView?: PluginConversationActivityView
  activeBatch?: string
  following?: boolean
  onInspectProcess?: () => void
  initialReasoning?: boolean
}) {
  const { _ } = useLingui()
  const activityBatch = createMemo(() =>
    isActivityTimelineItem(props.item) && props.item.kind === "activity-batch" ? props.item : undefined,
  )
  const exceptionalTools = createMemo(() =>
    isActivityTimelineItem(props.item) && props.item.kind === "activity-group" ? props.item : undefined,
  )
  const reasoning = createMemo(() => (props.item.kind === "activity-reasoning-summary" ? props.item : undefined))
  const activityReceipt = createMemo(() => {
    const item = props.item
    return isActivityTimelineItem(item) && item.kind === "activity-receipt" ? item : undefined
  })
  const guidedUser = createMemo(() => (props.item.kind === "guided-user" ? props.item : undefined))
  const nonRootUser = createMemo(() => (props.item.kind === "non-root-user" ? props.item : undefined))
  const timelineItem = createMemo(() => {
    const item = props.item
    if (item.kind === "guided-user" || item.kind === "non-root-user") return undefined
    if (!isActivityTimelineItem(item)) return item
    return item.kind === "passthrough" ? item.item : undefined
  })

  return (
    <Switch>
      <Match when={reasoning()}>
        {(item) => (
          <ActivityReasoning
            item={item()}
            working={props.working}
            initial={props.initialReasoning}
            preview={props.compactReasoning === true}
            view={props.activityView}
            onInspect={props.onInspectProcess}
          />
        )}
      </Match>
      <Match when={activityBatch()}>
        {(item) => (
          <ActivityBatch
            batch={item()}
            serverUrl={props.serverUrl}
            mode={props.activityDisplay ?? "balanced"}
            active={props.activeBatch === item().key}
            following={props.following !== false}
            reasoningPreview={props.compactReasoning}
            view={props.activityView}
            onInspect={props.onInspectProcess}
          />
        )}
      </Match>
      <Match when={exceptionalTools()}>{(item) => <ActivityTrace group={item()} serverUrl={props.serverUrl} />}</Match>
      <Match when={activityReceipt()}>{(item) => <ActivityReceipt item={item()} serverUrl={props.serverUrl} />}</Match>
      <Match when={guidedUser()}>
        {(item) => (
          <div data-slot="session-turn-rewind-wrapper" data-align="right">
            <Message message={item().message} parts={item().parts} userVariant="turn-bubble" />
          </div>
        )}
      </Match>
      <Match when={nonRootUser()}>
        {(item) => (
          <div data-slot="session-turn-rewind-wrapper">
            <div data-slot="session-turn-chip" data-origin={item().message.origin?.type ?? "guided"}>
              <Icon name={getSemanticIcon(originIconToken(item().message.origin))} size="small" />
              <span data-slot="session-turn-chip-label">{item().originLabel}</span>
            </div>
            <button
              type="button"
              data-slot="session-turn-rewind-button"
              onClick={(event) => {
                event.stopPropagation()
                props.onRewind?.()
              }}
              title={_(SESSION_TURN_DESC.rewindTitle)}
            >
              <Icon name={getSemanticIcon("session.rewind")} size="small" />
              <span>{_(SESSION_TURN_DESC.rewind)}</span>
            </button>
          </div>
        )}
      </Match>
      <Match when={timelineItem()}>
        {(item) => (
          <TimelineItemDisplay
            item={item()}
            serverUrl={props.serverUrl}
            working={props.working}
            compactReasoning={props.compactReasoning}
          />
        )}
      </Match>
    </Switch>
  )
}

function ProviderPrelude(props: {
  text: string
  elapsed?: string
  segments?: readonly string[]
  variant?: "running" | "completed"
}) {
  return (
    <div
      data-component="provider-prelude"
      data-variant={props.variant ?? "running"}
      role="status"
      aria-live="polite"
      aria-label={props.text}
    >
      <span data-slot="provider-prelude-text">{props.text}</span>
      <Show when={props.elapsed}>
        {(elapsed) => (
          <>
            <span data-slot="provider-prelude-separator" aria-hidden="true">
              ·
            </span>
            <span data-slot="provider-prelude-time" aria-hidden="true">
              {elapsed()}
            </span>
          </>
        )}
      </Show>
      <For each={props.segments ?? []}>
        {(segment) => (
          <>
            <span data-slot="provider-prelude-separator" aria-hidden="true">
              ·
            </span>
            <span data-slot="provider-prelude-stat">{segment}</span>
          </>
        )}
      </For>
    </div>
  )
}

function MailboxSourceBadge(props: { message: UserMessage }) {
  const { _ } = useLingui()
  const data = useData()
  const sourceName = createMemo(() => props.message.metadata?.sourceName as string | undefined)
  const sourceID = createMemo(
    () => (props.message.origin?.sessionID ?? props.message.metadata?.sourceSessionID) as string | undefined,
  )
  const label = createMemo(() => sourceName() ?? sourceID() ?? _(MAILBOX_DESC.anotherSession))

  return (
    <div data-slot="session-turn-mailbox-source">
      <Icon name={getSemanticIcon("session.inbox")} size="small" />
      <span>
        {_(MAILBOX_DESC.from)}{" "}
        <Show when={sourceID()} fallback={<span data-slot="mailbox-message-source-text">{label()}</span>}>
          <button data-slot="session-turn-mailbox-link" onClick={() => data.navigateToSession?.(sourceID()!)}>
            {label()}
          </button>
        </Show>
      </span>
    </div>
  )
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    rootMessage: UserMessage
    messages: readonly SessionTurnDisplayMessage[]
    compactionParentIDs?: ReadonlySet<string>
    lastUserMessageID?: string
    onUserInteracted?: () => void
    onRewind?: () => void
    rollbackActive?: boolean
    onReviewChanges?: (input: { messageID: string; file?: string }) => void
    onRestoreChanges?: (messageID: string) => void
    onForkMessage?: (messageID: string) => void
    executionSummary?: TurnExecutionSummary
    onExecutionDetails?: () => void
    activityDisplay?: ActivityDisplayMode
    compactReasoning?: boolean
    copyMessageText?: (messageID: string) => Promise<string>
    segment?: {
      user: boolean
      footer: boolean
      parts: readonly { messageID: string; id: string }[]
      before: boolean
      after: boolean
      beforeTool?: boolean
      beforeReasoning?: boolean
      processHeader?: boolean
      processBody?: boolean
      process?: { open: boolean; working: boolean; hasContent: boolean; hasTurnContent: boolean }
    }
    activityView?: PluginConversationActivityView
    following?: boolean
    executionState?: import("@ericsanchezok/synergy-sdk/client").TurnExecutionState
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const view = data.view
  const { _, i18n } = useLingui()
  const activityDisplay = createMemo(() => resolveActivityDisplay(props.activityDisplay))
  const segmentParts = createMemo(() => {
    if (!props.segment) return view.partTable()
    const table: Record<string, PartType[]> = {}
    for (const selected of props.segment.parts) {
      const part = view.partsFor(selected.messageID).find((part) => part.id === selected.id)
      if (part) (table[selected.messageID] ??= []).push(part)
    }
    return table
  })
  const partsFor = (messageID: string) =>
    props.segment ? (segmentParts()[messageID] ?? emptyParts) : view.partsFor(messageID)
  const showFooter = () => !props.segment || props.segment.footer
  const beforeBoundary = () => !props.segment || props.segment.before
  const afterBoundary = () => !props.segment || props.segment.after

  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyDisplayMessages: SessionTurnDisplayMessage[] = []
  const emptyDisplayItems: SessionTurnDisplayItem[] = []
  const emptyPermissions: PermissionRequest[] = []

  const emptyCompactionParentIDs = new Set<string>()
  const message = createMemo(() => props.rootMessage)
  const compactionParentIDs = createMemo(() => props.compactionParentIDs ?? emptyCompactionParentIDs)

  const specialUserMessageRenderer = createMemo(() => {
    const msg = message()
    if (!msg) return undefined
    return getSpecialUserMessageRenderer(msg)
  })

  const isLastUserMessage = createMemo(() => props.messageID === props.lastUserMessageID)

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return partsFor(msg.id)
  })

  const turnMessages = createMemo(() => props.messages, emptyDisplayMessages, { equals: same })

  const displayMessages = createMemo(() => filterMessagesForTurnDisplay(turnMessages()), emptyDisplayMessages, {
    equals: same,
  })

  const assistantMessages = createMemo(
    () => {
      return displayMessages().filter((message): message is AssistantMessage => message.role === "assistant")
    },
    emptyAssistant,
    { equals: same },
  )

  const lastAssistantMessage = createMemo(() => assistantMessages().at(-1))

  // Compaction failures own their error presentation in the lifecycle card.
  const error = createMemo(() => assistantMessages().findLast((m) => !isCompactionAssistant(m))?.error)
  const errorMessage = createMemo(() => {
    const value = error()
    if (!value) return ""
    const presentation = resolveSessionTurnError(value)
    if (!presentation) return ""
    if (presentation.kind === "message") return presentation.message
    if (presentation.kind === "model-unavailable") {
      return _(SESSION_TURN_DESC.modelUnavailable.id, presentation.values)
    }
    return _(SESSION_TURN_DESC.modelVariantUnavailable.id, presentation.values)
  })

  const permissions = createMemo(() => view.permissionsFor(props.sessionID))
  const permissionCount = createMemo(() => permissions().length)

  const shellModePart = createMemo(() => {
    if (props.segment) return
    const p = parts()
    if (!p.every((part) => part?.type === "text" && isSystemPart(part))) return

    const msgs = assistantMessages()
    if (msgs.length !== 1) return

    const msgParts = view.partsFor(msgs[0].id)
    if (msgParts.length !== 1) return

    const assistantPart = msgParts[0]
    if (assistantPart?.type === "tool" && assistantPart.tool === "bash") return assistantPart
  })

  const working = createMemo(
    () =>
      props.segment?.process?.working ??
      (props.executionState
        ? ["preparing", "running", "approval"].includes(props.executionState.status)
        : resolveTurnWorking({
            isLastUserMessage: isLastUserMessage(),
            messages: turnMessages(),
            sessionStatus: view.statusFor(props.sessionID),
          })),
  )

  const isToolRenderBoundary = (tool: string) => {
    try {
      return !!resolveExternalToolRenderer(tool, { externalLookup, externalLoadNotify })
    } catch {
      return true
    }
  }

  const projectAssistantMessage = (item: AssistantMessage): SessionTurnAssistantDisplayItem[] => {
    if (props.segment && isCompactionAssistant(item)) {
      const ownsRecovery = segmentParts()[item.id]?.some((part) => part.type === "compaction_recovery")
      const placeholder =
        props.segment.footer &&
        isProjectedCompactionAttempt(item) &&
        !view.partsFor(item.id).some((part) => part.type === "compaction_recovery")
      if (!ownsRecovery && !placeholder) return []
    }
    const sourceItems = collectSessionTurnTimelineItems([item], segmentParts(), true)
    return projectAssistantActivityItems({
      message: item,
      sourceItems,
      visibleItems: sourceItems,
      permissions: permissions(),
      resolveToolInfo: getToolInfo,
      isToolRenderBoundary,
    })
  }

  // Per-display-message projection memoization. Each message gets a stable
  // accessor, so a streaming delta re-projects only the message whose parts
  // changed; every other accessor returns its cached array. The element-wise
  // `same` guard below then short-circuits the whole downstream chain
  // (snapshot, boundaries, slot indexes) while a reply streams.
  const displayItemProjections = mapArray(
    () => displayMessages(),
    (item): Accessor<SessionTurnDisplayItem[]> => {
      return createMemo<SessionTurnDisplayItem[]>(() => {
        if (item.role === "user") {
          const userMsg = item as UserMessage
          if (userMsg.isRoot !== false) return emptyDisplayItems
          const itemParts = partsFor(item.id)
          // A user's own mid-run message (steer / follow-up) renders as their
          // message bubble; system-injected non-root messages (cortex, agenda,
          // …) render as a compact origin chip.
          const originType = userMsg.origin?.type ?? "user"
          if (originType === "user") {
            return [{ kind: "guided-user", message: userMsg, parts: itemParts }]
          }
          return [
            {
              kind: "non-root-user",
              message: userMsg,
              parts: itemParts,
              originLabel: chipLabelFromOrigin(userMsg.origin),
            },
          ]
        }
        return projectAssistantMessage(item)
      })
    },
  )

  const userCompactionDisplayItems = createMemo(
    () => {
      const msg = message()
      const display = displayMessages()
      const hasCompactionAssistant = display.some(
        (item) => item.role === "assistant" && isCompactionAssistant(item as AssistantMessage),
      )
      if (msg && !hasCompactionAssistant) return collectUserCompactionTimelineItems(msg, parts())
      return emptyDisplayItems
    },
    emptyDisplayItems,
    { equals: same },
  )

  const timelineItems = createMemo(
    () => {
      const result: SessionTurnDisplayItem[] = []
      result.push(...userCompactionDisplayItems())
      for (const accessor of displayItemProjections()) {
        result.push(...accessor())
      }

      return projectActivityBatches(result)
    },
    emptyDisplayItems,
    { equals: same },
  )
  const timelineMessageBoundaries = createMemo(() => {
    const result = new Map<string, { first: number; last: number; role: "user" | "assistant" }>()
    timelineItems().forEach((item, index) => {
      const current = result.get(item.message.id)
      if (current) current.last = index
      else result.set(item.message.id, { first: index, last: index, role: item.message.role })
    })
    return result
  })
  const hasCompactionEvent = createMemo(() => timelineItems().some(isCompactionDisplayItem))
  const showUserChrome = createMemo(
    () => (props.segment?.user ?? true) && shouldShowTurnUserChrome(message(), parts(), hasCompactionEvent()),
  )
  const [pendingDelayElapsed, setPendingDelayElapsed] = createSignal(false)
  const [animateReadyDiffPanel, setAnimateReadyDiffPanel] = createSignal(false)
  const diffSettlementStatus = createMemo(() => message()?.summary?.diffState?.status)
  const incompleteFileRecording = createMemo(() => {
    const state = message()?.summary?.diffState
    return state?.status === "partial" || (state?.status === "error" && state.code === "incomplete")
  })

  createEffect(
    on(diffSettlementStatus, (status) => {
      setPendingDelayElapsed(false)
      if (status !== "pending") return

      const pendingTimer = setTimeout(() => setPendingDelayElapsed(true), TURN_DIFF_PENDING_DELAY_MS)
      onCleanup(() => clearTimeout(pendingTimer))
    }),
  )

  createEffect(on(diffSettlementStatus, (status) => setAnimateReadyDiffPanel(status === "ready"), { defer: true }))

  const diffPanelState = createMemo(() => {
    const msg = message()
    const projected = shouldShowTurnDiffs(msg, {
      hasCompactionEvent: hasCompactionEvent(),
      isCompactedParent: !!msg && compactionParentIDs().has(msg.id),
    })
    return resolveTurnDiffPanelState(projected, pendingDelayElapsed(), (msg?.summary?.diffs.length ?? 0) > 0)
  })
  const visibleDiffPanelState = createMemo<Exclude<TurnDiffPanelState, "hidden"> | undefined>(() => {
    const state = diffPanelState()
    return state === "hidden" ? undefined : state
  })
  const latestAssistantTimelineItems = createMemo(() => {
    const latest = lastAssistantMessage()
    if (!latest) return []
    const display = displayMessages()
    const index = display.findIndex((item) => item.id === latest.id)
    // `display` and `displayItemProjections` are both derived from
    // displayMessages(), but the two memos lazily recompute on their own
    // schedule during a window replacement, so the index can transiently be
    // -1 (or the projection array shorter than display). Guard the access —
    // an empty projection is the graceful degradation path.
    const selected = (displayItemProjections()[index]?.() ?? []) as SessionTurnAssistantDisplayItem[]
    return selected as SessionTurnAssistantDisplayItem[]
  })
  const emptyTimelineItemSnapshot = {
    keys: [] as string[],
    map: new Map<string, SessionTurnDisplayItem>(),
  }
  const timelineItemSnapshot = createMemo(() => {
    const keys: string[] = []
    const map = new Map<string, SessionTurnDisplayItem>()
    for (const item of timelineItems()) {
      const key = displayItemStableKey(item)
      keys.push(key)
      map.set(key, item)
    }
    return { keys, map }
  }, emptyTimelineItemSnapshot)
  const timelineSlotIndexes = createMemo(() => {
    const items = timelineItems()
    const firstReasoning = items.findIndex(isReasoningDisplayItem)
    const lastReasoning = items.findLastIndex(isReasoningDisplayItem)
    const firstTool = items.findIndex(isToolRegionDisplayItem)
    const lastTool = items.findLastIndex(isToolRegionDisplayItem)
    return { firstReasoning, lastReasoning, firstTool, lastTool }
  })

  const markdownText = createMemo(() => {
    // Copy Markdown is only presented after the turn settles; while the reply
    // streams, return early so a token delta neither re-joins the accumulated
    // text nor subscribes this memo to the streaming part's text leaf.
    if (working()) return ""
    const last = lastAssistantMessage()
    if (!last) return ""
    const parts = view.partsFor(last.id)
    const texts: string[] = []
    let hasTextPart = false
    for (const part of parts) {
      if (part.type !== "text") continue
      hasTextPart = true
      const textPart = part as TextPart
      if (textPart.synthetic || textPart.origin === "system") continue
      const text = textPart.text?.trim()
      if (text) texts.push(text)
    }
    // Reasoning-only fallback: when the model produces no text parts,
    // collect reasoning content so Copy Markdown is still available.
    if (!hasTextPart) {
      for (const part of parts) {
        if (part.type === "reasoning") {
          const text = (part as ReasoningPart).text?.trim()
          if (text) texts.push(text)
        }
      }
    }
    return texts.join("\n\n")
  })

  const assistantTimestamp = createMemo(() => {
    const last = lastAssistantMessage()
    if (!last?.time.completed) return undefined
    const date = new Date(last.time.completed)
    const hours = date.getHours().toString().padStart(2, "0")
    const minutes = date.getMinutes().toString().padStart(2, "0")
    return `${hours}:${minutes}`
  })
  const copyController = createCopyController({
    text: markdownText,
    loadText: props.copyMessageText ? () => props.copyMessageText!(lastAssistantMessage()!.id) : undefined,
    copyLabel: _(SESSION_TURN_DESC.copyMarkdown),
    copiedLabel: _(SESSION_TURN_DESC.copied),
    failureDescription: _(SESSION_TURN_DESC.copyFailure),
  })
  const renderMessageSlot = (slot: MessageSlotName) => (
    <MessageSlotOutlet slot={slot} sessionId={props.sessionID} messageId={props.messageID} />
  )
  const renderCoreMessageSlot = (slot: MessageSlotName, messageId: string, role: "user" | "assistant") => (
    <MessageSlotOutlet slot={slot} sessionId={props.sessionID} messageId={messageId} role={role} />
  )
  const hasTimelineItems = createMemo(() => timelineItems().length > 0)
  const sessionStatus = createMemo(() => view.statusFor(props.sessionID))
  const showProviderPrelude = createMemo(() =>
    hasCompactionEvent()
      ? false
      : shouldShowProviderPrelude({
          working: working(),
          hasError: !!error(),
          latestAssistant: lastAssistantMessage(),
          latestAssistantTimelineItems: latestAssistantTimelineItems(),
          hasTurnContent: props.segment?.process?.hasTurnContent ?? hasTimelineItems(),
        }),
  )
  const showExecutionCompletion = createMemo(
    () => !working() && (!!props.executionSummary || !!props.onExecutionDetails),
  )

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
  })
  const following = () => props.following ?? !autoScroll.userScrolled()
  const [explicitProcessOpen, setExplicitProcessOpen] = createSignal<boolean>()
  const [heldProcessOpen, setHeldProcessOpen] = createSignal(false)
  createEffect(
    on(working, (value, previous) => {
      if (previous && !value && !following()) setHeldProcessOpen(true)
    }),
  )
  createEffect(() => {
    if (following()) setHeldProcessOpen(false)
  })
  const turnReasoning = createMemo(() =>
    turnMessages().flatMap((message) =>
      partsFor(message.id).filter((part): part is ReasoningPart => part.type === "reasoning" && !!part.text.trim()),
    ),
  )
  const reasoningRunning = () => {
    const latest = turnReasoning().at(-1)
    return working() && !!latest && latest.time?.end == null
  }
  const reasoningItem = (item: SessionTurnDisplayItem) =>
    item.kind === "activity-reasoning-summary" ||
    (isAssistantTimelineDisplayItem(item) && displayItemTimelineItem(item)?.part?.type === "reasoning")
  const processKey = () => `turn-process:${props.messageID}`
  const processOpen = () =>
    props.segment?.process?.open ??
    resolveActivityDisclosure({
      mode: activityDisplay(),
      working: working(),
      heldOpen: heldProcessOpen(),
      explicit: props.activityView?.getExpanded(processKey()) ?? explicitProcessOpen(),
    })
  const activeBatch = createMemo(() => {
    if (!working()) return undefined
    const running = timelineItems().findLast((item) => item.kind === "activity-batch" && item.state === "running")
    if (running?.kind === "activity-batch") return running.key
    const last = timelineItems().findLast((item) => !reasoningItem(item) && !isActivityBoundaryDisplayItem(item))
    return last?.kind === "activity-batch" ? last.key : undefined
  })
  const isProcessItem = (item: SessionTurnDisplayItem) => {
    if (props.segment?.processBody !== undefined) return props.segment.processBody
    if (item.kind === "activity-batch" || item.kind === "activity-reasoning-summary") return true
    const timeline = isAssistantTimelineDisplayItem(item) ? displayItemTimelineItem(item) : undefined
    if (timeline?.kind !== "part" || timeline.part.type !== "text") return false
    if (
      item.message.id !== lastAssistantMessage()?.id ||
      (item.message.role === "assistant" && item.message.finish === "tool-calls")
    )
      return true
    const parts = view.partsFor(item.message.id)
    const index = parts.findIndex((part) => part.id === timeline.part.id)
    return parts.slice(index + 1).some((part) => part.type === "tool")
  }
  const paused = () => {
    const status = sessionStatus()
    return isLastUserMessage() && status?.type === "paused" ? status : undefined
  }
  const hasProcess = createMemo(
    () =>
      (props.segment?.process?.hasContent ?? (turnReasoning().length > 0 || timelineItems().some(isProcessItem))) ||
      !!paused(),
  )
  const showProcessHeader = () => !props.segment || props.segment.processHeader
  const inspectProcess = () => {
    if (props.activityView) props.activityView.setExpanded(processKey(), true)
    else setExplicitProcessOpen(true)
  }
  const stopped = () =>
    props.executionState
      ? props.executionState.status === "stopped"
      : lastAssistantMessage()?.error?.name === "MessageAbortedError" ||
        (paused()?.type === "paused" && paused()?.reason === "aborted")
  const turnDuration = () => {
    const execution = props.executionState
    const start = execution?.startedAt ?? assistantMessages()[0]?.time.created
    const end = execution?.endedAt ?? lastAssistantMessage()?.time.completed
    return start !== undefined && end !== undefined ? Math.max(0, Math.round((end - start) / 1000)) : undefined
  }
  const activeAction = () => {
    if (props.executionState?.status === "approval")
      return _({ id: "session.process.approval", message: "Waiting for approval" })
    if (props.executionState?.status === "preparing")
      return _({ id: "activity.phase.prepare", message: "Preparing an action" })
    const batch = timelineItems().findLast((item) => item.kind === "activity-batch" && item.state === "running")
    const step = batch?.kind === "activity-batch" ? batch.steps.findLast((step) => step.state === "running") : undefined
    if (!step)
      return reasoningRunning()
        ? _({ id: "session.process.thinking", message: "Thinking" })
        : _({ id: "session.process.working", message: "Working" })
    if (step.family === "inspect-local") return _({ id: "session.process.reading", message: "Reading files" })
    if (step.family === "execute") return _({ id: "session.process.executing", message: "Running a command" })
    return _({ id: "session.process.working", message: "Working" })
  }
  const processLabel = () =>
    working()
      ? activeAction()
      : stopped()
        ? _({ id: "session.process.stopped", message: "Stopped" })
        : props.executionState?.status === "interrupted"
          ? _({ id: "session.process.interrupted", message: "Interrupted" })
          : props.executionState?.status === "failed" ||
              (!props.executionState && (error() || (paused()?.type === "paused" && paused()?.reason === "failed")))
            ? _({ id: "session.process.failed", message: "Execution failed" })
            : paused() || !lastAssistantMessage()?.time.completed
              ? _({ id: "session.process.paused", message: "Paused" })
              : turnDuration() !== undefined
                ? _({
                    id: "session.process.workedDuration",
                    message: "Worked for {seconds} s",
                    values: { seconds: turnDuration()! },
                  })
                : _({ id: "session.process.completed", message: "Work completed" })

  createEffect(
    on(permissionCount, (count, prev) => {
      if (!count) return
      if (prev !== undefined && count <= prev) return
      if (following()) autoScroll.forceScrollToBottom()
    }),
  )

  return (
    <div data-component="session-turn" data-activity-display={activityDisplay()} class={props.classes?.root}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            {(msg) => (
              <div
                ref={autoScroll.contentRef}
                data-message={msg().id}
                data-slot="session-turn-message-container"
                class={props.classes?.container}
              >
                <Switch>
                  <Match when={shellModePart()}>
                    {(shellPart) => <Part part={shellPart()} message={msg()} defaultOpen />}
                  </Match>
                  <Match when={true}>
                    <Show when={showUserChrome() && beforeBoundary()}>{renderMessageSlot("message.before-user")}</Show>
                    <Show when={showUserChrome()}>
                      <Show when={beforeBoundary()}>{renderCoreMessageSlot("message.before", msg().id, "user")}</Show>
                      {/* Mailbox source annotation */}
                      <Show when={(msg() as UserMessage).metadata?.mailbox && !specialUserMessageRenderer()}>
                        <MailboxSourceBadge message={msg() as UserMessage} />
                      </Show>
                      {/* User message */}
                      <div
                        data-slot="session-turn-rewind-wrapper"
                        data-align="right"
                        data-scroll-anchor={`turn-user:${msg().id}`}
                      >
                        <Show
                          when={specialUserMessageRenderer()}
                          fallback={
                            <Message
                              message={msg()}
                              parts={parts()}
                              userVariant="turn-bubble"
                              loadCopyText={props.copyMessageText ? () => props.copyMessageText!(msg().id) : undefined}
                            />
                          }
                        >
                          {(SpecialUserMessage) => (
                            <Dynamic component={SpecialUserMessage()} message={msg()} parts={parts()} />
                          )}
                        </Show>
                        <Show when={afterBoundary() && props.onRewind && !specialUserMessageRenderer()}>
                          <button
                            type="button"
                            data-slot="session-turn-rewind-button"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onRewind?.()
                            }}
                            title={_(SESSION_TURN_DESC.rewindTitle)}
                          >
                            <Icon name={getSemanticIcon("session.rewind")} size="small" />
                            <span>{_(SESSION_TURN_DESC.rewind)}</span>
                          </button>
                        </Show>
                        <Show when={afterBoundary()}>{renderCoreMessageSlot("message.actions", msg().id, "user")}</Show>
                      </div>
                      <Show when={afterBoundary()}>
                        {renderCoreMessageSlot("message.after", msg().id, "user")}
                        {renderMessageSlot("message.after-user")}
                      </Show>
                    </Show>
                    <Show
                      when={
                        hasTimelineItems() ||
                        (showProcessHeader() && (hasProcess() || showProviderPrelude())) ||
                        (showFooter() && (showExecutionCompletion() || (!working() && !!visibleDiffPanelState())))
                      }
                    >
                      <div data-slot="session-turn-timeline">
                        <Show when={showProcessHeader()}>
                          <div data-slot="turn-process-meta">
                            <Show when={hasProcess() || showProviderPrelude()}>
                              <button
                                type="button"
                                data-slot="turn-process-trigger"
                                data-scroll-anchor={processKey()}
                                aria-expanded={hasProcess() ? processOpen() : undefined}
                                disabled={!hasProcess()}
                                onClick={() => {
                                  const next = !processOpen()
                                  if (props.activityView) props.activityView.setExpanded(processKey(), next)
                                  else setExplicitProcessOpen(next)
                                }}
                              >
                                <Show
                                  when={
                                    working() &&
                                    !reasoningRunning() &&
                                    !timelineItems().some(
                                      (item) => item.kind === "activity-batch" && item.state === "running",
                                    )
                                  }
                                >
                                  <span data-slot="activity-live-indicator" aria-hidden="true" />
                                </Show>
                                <span>
                                  {showProviderPrelude()
                                    ? providerPreludeText(sessionStatus(), _(awaitingResponse))
                                    : processLabel()}
                                </span>
                                <Show when={props.executionState?.stoppedAt.length && !stopped()}>
                                  <span data-slot="turn-prior-stop">
                                    {_({ id: "session.process.priorStop", message: "Previously stopped" })}
                                  </span>
                                </Show>

                                <Show when={hasProcess()}>
                                  <Icon name={getSemanticIcon("navigation.expand")} size="small" />
                                </Show>
                              </button>
                            </Show>
                          </div>
                        </Show>
                        <For each={timelineItemSnapshot().keys}>
                          {(key, index) => {
                            const item = () => timelineItemSnapshot().map.get(key)
                            const boundary = () => {
                              const current = item()
                              return current ? timelineMessageBoundaries().get(current.message.id) : undefined
                            }
                            const activityFollows = () =>
                              adjacentActivityGroup(
                                timelineItemSnapshot().keys,
                                timelineItemSnapshot().map,
                                index(),
                                -1,
                              )
                            const activityContinues = () =>
                              adjacentActivityGroup(timelineItemSnapshot().keys, timelineItemSnapshot().map, index(), 1)
                            return (
                              <Show when={item()}>
                                {(current) => {
                                  const motionRef = createDisclosureMotionRef({
                                    visible: () =>
                                      !isActivityBoundaryDisplayItem(current()) &&
                                      (!isProcessItem(current()) || processOpen()),
                                    animate: following,
                                    content: displayItemVisualKind(current()) === "text",
                                    appear: () =>
                                      working() &&
                                      current().message.id === lastAssistantMessage()?.id &&
                                      displayItemVisualKind(current()) === "text",
                                  })
                                  return (
                                    <>
                                      <Show when={beforeBoundary() && boundary()?.first === index()}>
                                        {renderCoreMessageSlot(
                                          "message.before",
                                          current().message.id,
                                          current().message.role,
                                        )}
                                      </Show>
                                      <Show
                                        when={
                                          (props.segment?.beforeReasoning ?? beforeBoundary()) &&
                                          index() === timelineSlotIndexes().firstReasoning
                                        }
                                      >
                                        {renderMessageSlot("message.before-reasoning")}
                                      </Show>
                                      <Show
                                        when={
                                          (props.segment?.beforeTool ?? beforeBoundary()) &&
                                          index() === timelineSlotIndexes().firstTool
                                        }
                                      >
                                        {renderMessageSlot("message.before-tools")}
                                      </Show>
                                      <div
                                        data-slot="session-turn-timeline-item"
                                        data-scroll-anchor={key}
                                        data-kind={displayItemVisualKind(current())}
                                        data-activity-continues={activityContinues() ? "" : undefined}
                                        data-activity-follows={activityFollows() ? "" : undefined}
                                        ref={motionRef}
                                        data-compact-reasoning={
                                          props.compactReasoning &&
                                          (displayItemVisualKind(current()) === "reasoning" ||
                                            displayItemVisualKind(current()) === "activity-reasoning-summary")
                                            ? "true"
                                            : undefined
                                        }
                                      >
                                        <TimelineDisplay
                                          item={current()}
                                          initialReasoning={index() === 0 && reasoningItem(current())}
                                          serverUrl={data.serverUrl}
                                          rollbackActive={props.rollbackActive === true}
                                          onRewind={props.onRewind}
                                          working={working()}
                                          activityDisplay={activityDisplay()}
                                          activityView={props.activityView}
                                          activeBatch={activeBatch()}
                                          following={following()}
                                          onInspectProcess={inspectProcess}
                                          compactReasoning={props.compactReasoning}
                                        />
                                      </div>
                                      <Show when={afterBoundary() && index() === timelineSlotIndexes().lastReasoning}>
                                        {renderMessageSlot("message.after-reasoning")}
                                      </Show>
                                      <Show when={afterBoundary() && index() === timelineSlotIndexes().lastTool}>
                                        {renderMessageSlot("message.after-tools")}
                                      </Show>
                                      <Show when={afterBoundary() && boundary()?.last === index()}>
                                        {renderCoreMessageSlot(
                                          "message.actions",
                                          current().message.id,
                                          current().message.role,
                                        )}
                                        {renderCoreMessageSlot(
                                          "message.after",
                                          current().message.id,
                                          current().message.role,
                                        )}
                                      </Show>
                                    </>
                                  )
                                }}
                              </Show>
                            )
                          }}
                        </For>
                        <Show when={showFooter() && showExecutionCompletion()}>
                          <div data-slot="session-turn-timeline-item" data-kind="execution-completion">
                            <ExecutionCompletion
                              summary={props.executionSummary}
                              onDetails={props.onExecutionDetails}
                            />
                          </div>
                        </Show>
                        <Show
                          when={
                            showFooter() &&
                            !working() &&
                            (markdownText() || (props.copyMessageText && lastAssistantMessage()))
                          }
                        >
                          <div data-slot="session-turn-timeline-item" data-kind="copy-markdown">
                            <div data-slot="assistant-message-meta">
                              <Show keyed when={assistantTimestamp()}>
                                {(value) => <span data-slot="assistant-message-time">{value}</span>}
                              </Show>
                              <button
                                type="button"
                                data-slot="assistant-message-copy"
                                data-copy-state={copyController.state()}
                                aria-label={copyController.tooltip()}
                                disabled={copyController.disabled()}
                                onClick={() => void copyController.copy()}
                              >
                                <Icon
                                  name={
                                    copyController.copied() ? getSemanticIcon("state.success") : copyController.icon()
                                  }
                                  size="small"
                                />
                              </button>
                              <Show when={!!props.onForkMessage && !!lastAssistantMessage()}>
                                <button
                                  type="button"
                                  data-slot="assistant-message-fork"
                                  aria-label={_(SESSION_TURN_DESC.forkMessage)}
                                  onClick={() => props.onForkMessage?.(lastAssistantMessage()!.id)}
                                >
                                  <Icon name={getSemanticIcon("action.fork")} size="small" />
                                </button>
                              </Show>
                            </div>
                          </div>
                        </Show>
                        <Show
                          when={
                            showFooter() && (!working() || (msg().summary?.diffs.length ?? 0) > 0)
                              ? visibleDiffPanelState()
                              : undefined
                          }
                        >
                          {(state) => (
                            <div
                              data-slot="session-turn-timeline-item"
                              data-kind="review"
                              data-scroll-anchor={`turn-review:${msg().id}`}
                            >
                              <TurnChangeSummaryPanel
                                diffs={msg().summary?.diffs ?? []}
                                state={state()}
                                incomplete={incompleteFileRecording()}
                                animateReady={animateReadyDiffPanel()}
                                onUndoRequested={
                                  props.onRestoreChanges ? () => props.onRestoreChanges?.(msg().id) : undefined
                                }
                                onReviewRequested={() => props.onReviewChanges?.({ messageID: msg().id })}
                                onFileSelected={(file) => props.onReviewChanges?.({ messageID: msg().id, file })}
                              />
                            </div>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <Show when={showFooter() && error() && !stopped()}>
                      <ErrorCard error={errorMessage()} />
                    </Show>
                    <Show when={showFooter()}>{renderMessageSlot("message.after-message")}</Show>
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
