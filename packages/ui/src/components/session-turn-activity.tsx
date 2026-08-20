import type { MessageDescriptor } from "@lingui/core"
import type { AssistantMessage, PermissionRequest, ReasoningPart, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import {
  ACTIVITY_FAMILY_ORDER,
  ActivityDerivedMetadataSchema,
  activityFamilyForTool,
  activityGroupKey,
  activityScopeForTool,
  isActivityReceiptTool,
  isActivityGroupableTool,
  MAX_ACTIVITY_GROUP_STEPS,
  resolveActivityDisplay,
  type ActivityDerivedMetadata,
  type ActivityDisplayMode,
  type ActivityFamily,
  type ActivitySummaryState,
} from "@ericsanchezok/synergy-util/activity"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import type { IconName } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { timelineItemStableKey, type SessionTurnTimelineItem } from "./session-turn-timeline-item"
export { resolveActivityDisplay }
export type { ActivityDisplayMode, ActivityFamily }
export type ActivityGroupState = "running" | "error" | "waiting-approval" | "done"

export type ActivityStepProjection = {
  part: ToolPart
  family: ActivityFamily
  scopeKey: string
  icon: IconName
  title: string | MessageDescriptor
  subtitle?: string
  state: ActivityGroupState
}

export type ActivityToolInfoResolver = (
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
) => Pick<ActivityStepProjection, "icon" | "title" | "subtitle">

export type ActivityGroupItem = {
  kind: "activity-group"
  key: string
  message: AssistantMessage
  family: ActivityFamily
  scopeKey: string
  state: ActivityGroupState
  steps: ActivityStepProjection[]
  receipt: boolean
  topic?: ActivityTextSummary
}

export type ActivityTextSummary = {
  state: ActivitySummaryState | "pending"
  text?: string
  source?: "nano" | "partial-live"
}

export type ActivityReasoningSummaryItem = ActivityTextSummary & {
  kind: "activity-reasoning-summary"
  key: string
  message: AssistantMessage
  partID: string
}

export type ActivitySummaryFact = {
  family: ActivityFamily
  count: number
}

export type ActivitySummaryItem = {
  kind: "activity-summary"
  key: string
  message: AssistantMessage
  total: number
  facts: ActivitySummaryFact[]
  completed: boolean
  now?: NonNullable<ActivityDerivedMetadata["now"]>
}

export type ActivityReceiptItem = {
  kind: "activity-receipt"
  key: string
  message: AssistantMessage
  group: ActivityGroupItem
}

export type ActivityMessageBoundaryItem = {
  kind: "activity-boundary"
  key: string
  message: AssistantMessage
}

export type ActivityPassthroughItem = {
  kind: "passthrough"
  item: SessionTurnTimelineItem
  message: AssistantMessage
}

export type ActivityTimelineItem =
  | ActivityGroupItem
  | ActivityReasoningSummaryItem
  | ActivitySummaryItem
  | ActivityReceiptItem
  | ActivityMessageBoundaryItem
  | ActivityPassthroughItem

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function parsedInput(part: ToolPart): Record<string, unknown> {
  if (Object.keys(part.state.input).length > 0) return part.state.input
  if (part.state.status !== "pending" && part.state.status !== "generating") return part.state.input
  if (!part.state.raw) return {}
  try {
    return record(parsePartialJson(part.state.raw))
  } catch {
    return {}
  }
}

function permissionForStep(
  messageID: string,
  part: ToolPart,
  permissions: readonly PermissionRequest[],
): PermissionRequest | undefined {
  return permissions.find(
    (permission) => permission.tool?.messageID === messageID && permission.tool.callID === part.callID,
  )
}

function stepState(part: ToolPart, permission: PermissionRequest | undefined): ActivityGroupState {
  if (permission) return "waiting-approval"
  if (part.state.status === "error") return "error"
  if (part.state.status === "completed") return "done"
  return "running"
}

function groupState(steps: readonly ActivityStepProjection[]): ActivityGroupState {
  if (steps.some((step) => step.state === "waiting-approval")) return "waiting-approval"
  if (steps.some((step) => step.state === "error")) return "error"
  if (steps.some((step) => step.state === "running")) return "running"
  return "done"
}

function timelineItemIdentity(item: SessionTurnTimelineItem): string {
  if (item.kind === "compaction") return `compaction:${item.message.id}`
  return `${item.message.id}:${item.part.id}`
}

export function activityItemStableKey(item: ActivityTimelineItem): string {
  if (item.kind === "passthrough") return timelineItemStableKey(item.item)
  return item.key
}

function isVisible(item: SessionTurnTimelineItem, visibleIdentities: ReadonlySet<string>): boolean {
  return visibleIdentities.has(timelineItemIdentity(item))
}

function isOrdinaryTool(
  item: SessionTurnTimelineItem,
  isToolRenderBoundary: (tool: string) => boolean,
): item is Extract<SessionTurnTimelineItem, { kind: "part" }> & { part: ToolPart } {
  if (item.kind !== "part" || item.part.type !== "tool") return false
  const metadata = record(item.part.state.metadata)
  return (
    (item.part.state.status === "error" || isActivityGroupableTool(item.part.tool, metadata)) &&
    !isToolRenderBoundary(item.part.tool)
  )
}

function hasStableInput(part: ToolPart): boolean {
  if (part.state.status !== "pending" && part.state.status !== "generating") return true
  return Object.keys(part.state.input).length > 0
}

// Frozen terminal step projections keyed by part identity. The store keeps
// stable references for unchanged parts, so a completed/error tool step is
// projected once and reused across every downstream re-projection (streaming
// deltas, settle flip, window rewrites). Steps with a pending approval never
// touch the cache: the waiting-approval projection must be replaced by the
// terminal projection once the approval is replied, and a cached waiting
// step would leave the row stuck. WeakMap entries collect with their part.
const frozenStepByPart = new WeakMap<ToolPart, ActivityStepProjection>()

function frozenStep(part: ToolPart): ActivityStepProjection | undefined {
  const status = part.state.status
  if (status !== "completed" && status !== "error") return undefined
  return frozenStepByPart.get(part)
}

function freezeStep(part: ToolPart, step: ActivityStepProjection): ActivityStepProjection {
  if (part.state.status === "completed" || part.state.status === "error") frozenStepByPart.set(part, step)
  return step
}

function makeStep(
  message: AssistantMessage,
  part: ToolPart,
  permissions: readonly PermissionRequest[],
  resolveToolInfo: ActivityToolInfoResolver,
): ActivityStepProjection {
  const input = parsedInput(part)
  const metadata = record(part.state.metadata)
  const family = activityFamilyForTool(part.tool, input, metadata)
  const scope = activityScopeForTool(input, metadata, { family, workspaceRoot: message.path.root })
  let info: ReturnType<ActivityToolInfoResolver>
  try {
    info = resolveToolInfo(part.tool, input, metadata)
  } catch {
    info = { icon: getSemanticIcon("performance.tools"), title: part.tool, subtitle: scope.label }
  }
  const permission = permissionForStep(message.id, part, permissions)
  return {
    part,
    family,
    scopeKey: scope.key,
    icon: info.icon,
    title: info.title,
    subtitle: info.subtitle ?? scope.label,
    state: stepState(part, permission),
  }
}

function activityMetadata(message: AssistantMessage): ActivityDerivedMetadata | undefined {
  const parsed = ActivityDerivedMetadataSchema.safeParse(message.metadata?.activity)
  return parsed.success ? parsed.data : undefined
}

function reasoningSummary(message: AssistantMessage, partID: string, terminal: boolean): ActivityReasoningSummaryItem {
  return {
    kind: "activity-reasoning-summary",
    key: `activity-reasoning:${message.id}:${partID}`,
    message,
    partID,
    state: terminal ? "fallback" : "pending",
  }
}

function makeGroup(
  message: AssistantMessage,
  step: ActivityStepProjection,
  receipt: boolean,
  persistedKey?: string,
): ActivityGroupItem {
  return {
    kind: "activity-group",
    key: persistedKey ?? activityGroupKey(message.id, step.family, step.scopeKey, step.part.id),
    message,
    family: step.family,
    scopeKey: step.scopeKey,
    state: step.state,
    steps: [step],
    receipt,
  }
}

export function projectAssistantActivityItems(input: {
  message: AssistantMessage
  sourceItems: readonly SessionTurnTimelineItem[]
  visibleItems: readonly SessionTurnTimelineItem[]
  permissions: readonly PermissionRequest[]
  resolveToolInfo: ActivityToolInfoResolver
  isToolRenderBoundary?: (tool: string) => boolean
}): ActivityTimelineItem[] {
  const result: ActivityTimelineItem[] = []
  const isRenderBoundary = input.isToolRenderBoundary ?? (() => false)
  const visibleByIdentity = new Map(input.visibleItems.map((item) => [timelineItemIdentity(item), item]))
  const visibleIdentities = new Set(visibleByIdentity.keys())
  const metadata = activityMetadata(input.message)
  const ordinaryPartIDs = new Set(
    input.sourceItems.flatMap((item) => (isOrdinaryTool(item, isRenderBoundary) ? [item.part.id] : [])),
  )
  const persistedGroupByPartID = new Map<string, string>()
  const validPersistedGroupKeys = new Set<string>()
  for (const [key, group] of Object.entries(metadata?.groups ?? {})) {
    const partIDs = group.signature?.split(":").filter(Boolean) ?? []
    if (partIDs.length === 0 || partIDs.some((partID) => !ordinaryPartIDs.has(partID))) continue
    validPersistedGroupKeys.add(key)
    for (const partID of partIDs) persistedGroupByPartID.set(partID, key)
  }
  let pendingGroup: ActivityGroupItem | undefined
  let pendingPersistedKey: string | undefined

  const flush = () => {
    if (!pendingGroup) return
    const stored = metadata?.groups?.[pendingGroup.key]
    const validStored =
      stored && (!stored.signature || validPersistedGroupKeys.has(pendingGroup.key)) ? stored : undefined
    if (validStored?.text) pendingGroup.topic = { state: validStored.state, text: validStored.text }
    pendingGroup.state = pendingGroup.topic?.state === "live" ? "running" : groupState(pendingGroup.steps)
    result.push(pendingGroup)
    pendingGroup = undefined
    pendingPersistedKey = undefined
  }

  for (const source of input.sourceItems) {
    if (!isOrdinaryTool(source, isRenderBoundary)) {
      flush()
      const visible = visibleByIdentity.get(timelineItemIdentity(source))
      if (source.kind === "reasoning") {
        if (!visible) continue
        result.push(reasoningSummary(input.message, source.part.id, visible.kind === "part"))
        continue
      }
      if (!visible) continue
      result.push({ kind: "passthrough", item: visible, message: input.message })
      continue
    }

    if (!isVisible(source, visibleIdentities)) {
      flush()
      continue
    }

    const permission = permissionForStep(input.message.id, source.part, input.permissions)
    if (!hasStableInput(source.part) && !permission && source.part.state.status !== "error") {
      flush()
      continue
    }
    const step = permission
      ? makeStep(input.message, source.part, input.permissions, input.resolveToolInfo)
      : (frozenStep(source.part) ??
        freezeStep(source.part, makeStep(input.message, source.part, input.permissions, input.resolveToolInfo)))
    const receipt = isActivityReceiptTool(source.part.tool, step.family)
    const defaultKey = activityGroupKey(input.message.id, step.family, step.scopeKey, step.part.id)
    const legacyStored = metadata?.groups?.[defaultKey]
    const persistedKey = receipt
      ? undefined
      : (persistedGroupByPartID.get(step.part.id) ?? (legacyStored && !legacyStored.signature ? defaultKey : undefined))

    const canMerge =
      !receipt &&
      pendingGroup &&
      !pendingGroup.receipt &&
      pendingGroup.steps.length < MAX_ACTIVITY_GROUP_STEPS &&
      (persistedKey
        ? pendingPersistedKey === persistedKey
        : !pendingPersistedKey && pendingGroup.family === step.family && pendingGroup.scopeKey === step.scopeKey)

    if (canMerge && pendingGroup) {
      pendingGroup.steps.push(step)
      pendingGroup.state = groupState(pendingGroup.steps)
      continue
    }

    flush()
    pendingGroup = makeGroup(input.message, step, receipt, persistedKey)
    pendingPersistedKey = persistedKey
  }

  flush()
  return result
}
export function isActivityTimelineItem(value: ActivityTimelineItem | unknown): value is ActivityTimelineItem {
  if (!value || typeof value !== "object") return false
  const kind = (value as { kind?: unknown }).kind
  return (
    kind === "activity-group" ||
    kind === "activity-reasoning-summary" ||
    kind === "activity-summary" ||
    kind === "activity-receipt" ||
    kind === "activity-boundary" ||
    kind === "passthrough"
  )
}

function messageHasBalancedOutput(items: readonly unknown[], messageID: string): boolean {
  return items.some(
    (item) =>
      isActivityTimelineItem(item) &&
      item.message.id === messageID &&
      (item.kind === "activity-group" ||
        item.kind === "activity-receipt" ||
        (item.kind === "passthrough" && item.item.kind !== "compaction")),
  )
}

/**
 * Balanced reasoning projection, applied per assistant message. While a
 * message streams, its first `Thinking…` status row stays in place (upgraded
 * to its own live reasoning line under compact reasoning) and repeated
 * reasoning rows for the same message are dropped. A completed message
 * follows settled semantics even while the turn still works: compact
 * reasoning anchors one settled row at the latest reasoning part's position,
 * while non-compact reasoning is hidden when the message produced output and
 * becomes one `Reasoning` fallback when the message is reasoning-only.
 */
export function projectBalancedReasoningItems<T>(
  items: readonly (ActivityTimelineItem | T)[],
  working: boolean,
  options?: {
    /** Live reasoning part per assistant message; while working, replaces each message's Thinking… row with its own streaming reasoning line. */
    compactReasoningParts?: ReadonlyMap<string, ReasoningPart>
  },
): (ActivityTimelineItem | T)[] {
  const liveParts = options?.compactReasoningParts
  const summariesByMessage = new Map<string, { item: ActivityReasoningSummaryItem; index: number }[]>()
  items.forEach((item, index) => {
    if (!isActivityTimelineItem(item) || item.kind !== "activity-reasoning-summary") return
    const list = summariesByMessage.get(item.message.id) ?? []
    list.push({ item, index })
    summariesByMessage.set(item.message.id, list)
  })
  if (summariesByMessage.size === 0) return [...items]

  const replace = new Map<number, ActivityTimelineItem>()
  const drop = new Set<number>()
  for (const [messageID, summaries] of summariesByMessage) {
    const message = summaries[0].item.message
    const completed = !working || message.time.completed != null
    const livePart = liveParts?.get(messageID)
    if (livePart) {
      // Compact: a streaming message anchors its live line at the first
      // Thinking row; a completed message anchors its settled row at the
      // latest reasoning part's position.
      const anchor = completed ? summaries[summaries.length - 1]! : summaries[0]!
      replace.set(anchor.index, {
        kind: "passthrough",
        item: { kind: "reasoning", message, part: livePart },
        message,
      })
      for (const summary of summaries) {
        if (summary !== anchor) drop.add(summary.index)
      }
      continue
    }
    if (completed && messageHasBalancedOutput(items, messageID)) {
      for (const summary of summaries) drop.add(summary.index)
      continue
    }
    const keep = summaries[0]!
    if (completed) replace.set(keep.index, { ...keep.item, state: "fallback" })
    for (const summary of summaries) {
      if (summary !== keep) drop.add(summary.index)
    }
  }

  const result: (ActivityTimelineItem | T)[] = []
  items.forEach((item, index) => {
    if (drop.has(index)) return
    result.push(replace.get(index) ?? item)
  })
  return result
}

function receiptForGroup(group: ActivityGroupItem, step?: ActivityStepProjection): ActivityReceiptItem {
  const receiptGroup = step
    ? {
        ...group,
        key: activityGroupKey(group.message.id, group.family, group.scopeKey, step.part.id),
        state: step.state,
        steps: [step],
      }
    : group
  return {
    kind: "activity-receipt",
    key: `activity-receipt:${receiptGroup.key}`,
    message: receiptGroup.message,
    group: receiptGroup,
  }
}

function explicitReceipts(group: ActivityGroupItem): ActivityReceiptItem[] {
  if (group.receipt) return [receiptForGroup(group)]
  return group.steps.flatMap((step) =>
    step.state === "error" || step.state === "waiting-approval" ? [receiptForGroup(group, step)] : [],
  )
}

export function projectMinimalActivityItems<T>(
  items: readonly (ActivityTimelineItem | T)[],
  rootMessageID: string,
  completed: boolean,
): (ActivityTimelineItem | T)[] {
  const groups = items.filter(
    (item): item is ActivityGroupItem =>
      isActivityTimelineItem(item) && item.kind === "activity-group" && !item.receipt,
  )
  if (groups.length === 0) {
    const result: (ActivityTimelineItem | T)[] = []
    for (const item of items) {
      if (isActivityTimelineItem(item) && item.kind === "activity-reasoning-summary") continue
      if (isActivityTimelineItem(item) && item.kind === "activity-group") result.push(...explicitReceipts(item))
      else result.push(item)
    }
    return result
  }

  const counts = new Map<ActivityFamily, number>()
  let total = 0
  for (const group of groups) {
    total += group.steps.length
    for (const step of group.steps) counts.set(step.family, (counts.get(step.family) ?? 0) + 1)
  }
  const facts = ACTIVITY_FAMILY_ORDER.flatMap((family) => {
    const count = counts.get(family) ?? 0
    return count > 0 ? [{ family, count }] : []
  }).slice(0, 3)
  const now = items.reduce<NonNullable<ActivityDerivedMetadata["now"]> | undefined>((latest, item) => {
    if (!isActivityTimelineItem(item)) return latest
    const candidate = activityMetadata(item.message)?.now
    if (!candidate) return latest
    return !latest || candidate.updatedAt > latest.updatedAt ? candidate : latest
  }, undefined)
  const first = groups[0]
  const summary: ActivitySummaryItem = {
    kind: "activity-summary",
    key: `activity-summary:${rootMessageID}`,
    message: first.message,
    total,
    facts,
    completed,
    now,
  }
  let inserted = false
  const preservedMessages = new Set<string>()
  const result: (ActivityTimelineItem | T)[] = []
  for (const item of items) {
    if (isActivityTimelineItem(item) && item.kind === "activity-reasoning-summary") continue
    if (!isActivityTimelineItem(item) || item.kind !== "activity-group") {
      result.push(item)
      if (isActivityTimelineItem(item)) preservedMessages.add(item.message.id)
      continue
    }
    if (!inserted && !item.receipt) {
      result.push(summary)
      preservedMessages.add(summary.message.id)
      inserted = true
    } else if (!item.receipt && !preservedMessages.has(item.message.id)) {
      result.push({ kind: "activity-boundary", key: `activity-boundary:${item.message.id}`, message: item.message })
      preservedMessages.add(item.message.id)
    }
    const receipts = explicitReceipts(item)
    result.push(...receipts)
    if (receipts.length > 0) preservedMessages.add(item.message.id)
  }
  return result
}
