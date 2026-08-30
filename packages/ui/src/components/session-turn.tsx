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
import { ActivityReasoningSummary, ActivityReceipt, ActivityTrace, MinimalActivitySummary } from "./activity-trace"
import { CompactReasoningLine } from "./compact-reasoning"
import {
  activityItemStableKey,
  isActivityTimelineItem,
  projectAssistantActivityItems,
  projectBalancedReasoningItems,
  projectMinimalActivityItems,
  resolveActivityDisplay,
  type ActivityDisplayMode,
  type ActivityTimelineItem,
} from "./session-turn-activity"
import { timelineItemStableKey, timelineVisualKind, type SessionTurnTimelineItem } from "./session-turn-timeline-item"
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

  if (lastAssistant?.time.completed == null) return input.sessionStatus?.type !== "idle"
  return !!input.sessionStatus && input.sessionStatus.type !== "idle"
}

export function providerPreludeText(status: SessionStatus | undefined): string {
  if (status?.type === "busy") {
    const description = status.description?.trim()
    if (description) return description
  }
  return "Awaiting response\u2026"
}

export function shouldShowProviderPrelude(input: {
  working: boolean
  hasError: boolean
  latestAssistant?: AssistantMessage
  latestAssistantTimelineItems: readonly (SessionTurnTimelineItem | ActivityTimelineItem)[]
}): boolean {
  if (!input.working || input.hasError) return false
  if (!input.latestAssistant) return true
  if (input.latestAssistant.time.completed != null) return false
  return input.latestAssistantTimelineItems.length === 0
}

function TimelineItemDisplay(props: {
  item: SessionTurnTimelineItem
  serverUrl: string
  working?: boolean
  compactReasoning?: boolean
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
  if (props.item.kind === "media-pending") return <MediaGenerationCard part={props.item.part} />
  if (isMediaGenerationToolPart(props.item.part)) {
    return <AttachmentGallery files={props.item.files} serverUrl={props.serverUrl} />
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
  return displayItemTimelineItem(item)?.kind === "reasoning"
}

function isToolRegionDisplayItem(item: SessionTurnDisplayItem): boolean {
  if (!isAssistantTimelineDisplayItem(item)) return false
  if (isActivityTimelineItem(item)) {
    return item.kind === "activity-group" || item.kind === "activity-summary" || item.kind === "activity-receipt"
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
}) {
  const { _ } = useLingui()
  const activityGroup = createMemo(() => {
    const item = props.item
    return isActivityTimelineItem(item) && item.kind === "activity-group" ? item : undefined
  })
  const activitySummary = createMemo(() => {
    const item = props.item
    return isActivityTimelineItem(item) && item.kind === "activity-summary" ? item : undefined
  })
  const activityReasoning = createMemo(() => {
    const item = props.item
    return isActivityTimelineItem(item) && item.kind === "activity-reasoning-summary" ? item : undefined
  })
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
      <Match when={activityGroup()}>{(item) => <ActivityTrace group={item()} serverUrl={props.serverUrl} />}</Match>
      <Match when={activitySummary()}>{(item) => <MinimalActivitySummary item={item()} />}</Match>
      <Match when={activityReasoning()}>{(item) => <ActivityReasoningSummary item={item()} />}</Match>
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
    messages: SessionTurnDisplayMessage[]
    compactionParentIDs?: Set<string>
    lastUserMessageID?: string
    onUserInteracted?: () => void
    onRewind?: () => void
    rollbackActive?: boolean
    onReviewChanges?: (input: { messageID: string; file?: string }) => void
    onForkMessage?: (messageID: string) => void
    activityDisplay?: ActivityDisplayMode
    compactReasoning?: boolean
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
    return view.partsFor(msg.id)
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
  const error = createMemo(() => assistantMessages().find((m) => !isCompactionAssistant(m) && m.error)?.error)
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
    const p = parts()
    if (!p.every((part) => part?.type === "text" && isSystemPart(part))) return

    const msgs = assistantMessages()
    if (msgs.length !== 1) return

    const msgParts = view.partsFor(msgs[0].id)
    if (msgParts.length !== 1) return

    const assistantPart = msgParts[0]
    if (assistantPart?.type === "tool" && assistantPart.tool === "bash") return assistantPart
  })

  const working = createMemo(() =>
    resolveTurnWorking({
      isLastUserMessage: isLastUserMessage(),
      messages: turnMessages(),
      sessionStatus: view.statusFor(props.sessionID),
    }),
  )

  const isToolRenderBoundary = (tool: string) => {
    try {
      return !!resolveExternalToolRenderer(tool, { externalLookup, externalLoadNotify })
    } catch {
      return true
    }
  }

  const projectAssistantMessage = (item: AssistantMessage): SessionTurnAssistantDisplayItem[] => {
    const visibleItems = collectSessionTurnTimelineItems([item], view.partTable(), working())
    if (activityDisplay() === "full") return visibleItems

    const sourceItems = collectSessionTurnTimelineItems([item], view.partTable(), true)
    return projectAssistantActivityItems({
      message: item,
      sourceItems,
      visibleItems,
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
          const itemParts = view.partsFor(item.id)
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
      // Subscribe to working() directly: settling flips it and must re-project
      // every message once (reasoning promotion/hiding in full mode). The
      // per-message accessors below stay cached across streaming deltas.
      const isWorking = working()
      const result: SessionTurnDisplayItem[] = []
      const msg = message()
      result.push(...userCompactionDisplayItems())
      for (const accessor of displayItemProjections()) {
        result.push(...accessor())
      }
      const assistants = displayMessages().filter(
        (item): item is AssistantMessage =>
          item.role === "assistant" && !isCompactionAssistant(item as AssistantMessage),
      )
      if (activityDisplay() === "minimal") {
        return projectMinimalActivityItems(result, msg?.id ?? props.messageID, !isWorking) as SessionTurnDisplayItem[]
      }
      if (activityDisplay() === "balanced") {
        let liveReasoningParts: Map<string, ReasoningPart> | undefined
        if (props.compactReasoning && isWorking) {
          liveReasoningParts = new Map()
          for (const assistant of assistants) {
            const reasoningPart = view
              .partsFor(assistant.id)
              .findLast((part): part is ReasoningPart => part.type === "reasoning" && Boolean(part.text.trim()))
            if (reasoningPart) liveReasoningParts.set(assistant.id, reasoningPart)
          }
        }
        const projected = projectBalancedReasoningItems(result, isWorking, {
          compactReasoningParts: liveReasoningParts,
        }) as SessionTurnDisplayItem[]
        return props.compactReasoning && !isWorking
          ? injectPersistedReasoningItems(projected, assistants, view.partTable())
          : projected
      }
      if (props.compactReasoning) {
        if (isWorking) return compactReasoningTimelineItems(result)
        return injectPersistedReasoningItems(result, assistants, view.partTable())
      }
      return result
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
  const showUserChrome = createMemo(() => shouldShowTurnUserChrome(message(), parts(), hasCompactionEvent()))
  const [pendingDelayElapsed, setPendingDelayElapsed] = createSignal(false)
  const [animateReadyDiffPanel, setAnimateReadyDiffPanel] = createSignal(false)
  const diffSettlementStatus = createMemo(() => message()?.summary?.diffState?.status)

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
    return resolveTurnDiffPanelState(projected, pendingDelayElapsed())
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
    if (activityDisplay() !== "minimal") return selected as SessionTurnAssistantDisplayItem[]
    return projectMinimalActivityItems(selected, message()?.id ?? props.messageID, !working())
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
  const [providerPreludeNow, setProviderPreludeNow] = createSignal(Date.now())
  const providerPreludeStarted = createMemo(() => message()?.time.created)
  const providerPreludeElapsed = createMemo(() =>
    providerPreludeElapsedLabel(providerPreludeStarted(), providerPreludeNow()),
  )
  const showProviderPrelude = createMemo(() =>
    hasCompactionEvent()
      ? false
      : shouldShowProviderPrelude({
          working: working(),
          hasError: !!error(),
          latestAssistant: lastAssistantMessage(),
          latestAssistantTimelineItems: latestAssistantTimelineItems(),
        }),
  )
  const completedTurnStats = createMemo(() => {
    if (working() || hasCompactionEvent() || error()) return undefined
    return turnCompletionStats(assistantMessages(), i18n?.()?.locale)
  })

  createEffect(() => {
    if (!showProviderPrelude()) {
      setProviderPreludeNow(Date.now())
      return
    }

    setProviderPreludeNow(Date.now())
    const timer = setInterval(() => setProviderPreludeNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
  })

  createEffect(
    on(permissionCount, (count, prev) => {
      if (!count) return
      if (prev !== undefined && count <= prev) return
      autoScroll.forceScrollToBottom()
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
                    <Show when={showUserChrome()}>{renderMessageSlot("message.before-user")}</Show>
                    <Show when={showUserChrome()}>
                      {renderCoreMessageSlot("message.before", msg().id, "user")}
                      {/* Mailbox source annotation */}
                      <Show when={(msg() as UserMessage).metadata?.mailbox && !specialUserMessageRenderer()}>
                        <MailboxSourceBadge message={msg() as UserMessage} />
                      </Show>
                      {/* User message */}
                      <div data-slot="session-turn-rewind-wrapper" data-align="right">
                        <Show
                          when={specialUserMessageRenderer()}
                          fallback={<Message message={msg()} parts={parts()} userVariant="turn-bubble" />}
                        >
                          {(SpecialUserMessage) => (
                            <Dynamic component={SpecialUserMessage()} message={msg()} parts={parts()} />
                          )}
                        </Show>
                        <Show when={props.onRewind && !specialUserMessageRenderer()}>
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
                        {renderCoreMessageSlot("message.actions", msg().id, "user")}
                      </div>
                      {renderCoreMessageSlot("message.after", msg().id, "user")}
                      {renderMessageSlot("message.after-user")}
                    </Show>
                    <Show
                      when={
                        hasTimelineItems() ||
                        showProviderPrelude() ||
                        completedTurnStats() ||
                        (!working() && !!visibleDiffPanelState())
                      }
                    >
                      <div data-slot="session-turn-timeline">
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
                                {(current) => (
                                  <>
                                    <Show when={boundary()?.first === index()}>
                                      {renderCoreMessageSlot(
                                        "message.before",
                                        current().message.id,
                                        current().message.role,
                                      )}
                                    </Show>
                                    <Show when={index() === timelineSlotIndexes().firstReasoning}>
                                      {renderMessageSlot("message.before-reasoning")}
                                    </Show>
                                    <Show when={index() === timelineSlotIndexes().firstTool}>
                                      {renderMessageSlot("message.before-tools")}
                                    </Show>
                                    <div
                                      data-slot="session-turn-timeline-item"
                                      data-kind={displayItemVisualKind(current())}
                                      data-activity-continues={activityContinues() ? "" : undefined}
                                      data-activity-follows={activityFollows() ? "" : undefined}
                                      hidden={isActivityBoundaryDisplayItem(current())}
                                      data-compact-reasoning={
                                        props.compactReasoning && displayItemVisualKind(current()) === "reasoning"
                                          ? "true"
                                          : undefined
                                      }
                                    >
                                      <TimelineDisplay
                                        item={current()}
                                        serverUrl={data.serverUrl}
                                        rollbackActive={props.rollbackActive === true}
                                        onRewind={props.onRewind}
                                        working={working()}
                                        compactReasoning={
                                          props.compactReasoning && displayItemVisualKind(current()) === "reasoning"
                                        }
                                      />
                                    </div>
                                    <Show when={index() === timelineSlotIndexes().lastReasoning}>
                                      {renderMessageSlot("message.after-reasoning")}
                                    </Show>
                                    <Show when={index() === timelineSlotIndexes().lastTool}>
                                      {renderMessageSlot("message.after-tools")}
                                    </Show>
                                    <Show when={boundary()?.last === index()}>
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
                                )}
                              </Show>
                            )
                          }}
                        </For>
                        <Show when={showProviderPrelude()}>
                          <div data-slot="session-turn-timeline-item" data-kind="provider-prelude">
                            <ProviderPrelude
                              text={providerPreludeText(sessionStatus())}
                              elapsed={providerPreludeElapsed()}
                            />
                          </div>
                        </Show>
                        <Show when={completedTurnStats()}>
                          {(stats) => (
                            <div data-slot="session-turn-timeline-item" data-kind="provider-prelude">
                              <ProviderPrelude
                                text={_(SESSION_TURN_DESC.completed)}
                                elapsed={stats().duration}
                                segments={stats().segments}
                                variant="completed"
                              />
                            </div>
                          )}
                        </Show>
                        <Show when={!working() && markdownText()}>
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
                        <Show when={!working() ? visibleDiffPanelState() : undefined}>
                          {(state) => (
                            <TurnChangeSummaryPanel
                              diffs={msg().summary?.diffs ?? []}
                              state={state()}
                              animateReady={animateReadyDiffPanel()}
                              onReviewRequested={() => props.onReviewChanges?.({ messageID: msg().id })}
                              onFileSelected={(file) => props.onReviewChanges?.({ messageID: msg().id, file })}
                            />
                          )}
                        </Show>
                      </div>
                    </Show>
                    <Show when={error()}>
                      <ErrorCard error={errorMessage()} />
                    </Show>
                    {renderMessageSlot("message.after-message")}
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
