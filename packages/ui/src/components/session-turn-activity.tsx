import type { MessageDescriptor } from "@lingui/core"
import type { AssistantMessage, AttachmentPart, PermissionRequest, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import {
  ACTIVITY_FAMILY_ORDER,
  ActivityDerivedMetadataSchema,
  activityFamilyForTool,
  activityGroupKey,
  activityScopeForTool,
  isActivityReceiptTool,
  MAX_ACTIVITY_GROUP_STEPS,
  resolveActivityDisplay,
  type ActivityDerivedMetadata,
  type ActivityDisplayMode,
  type ActivityFamily,
  type ActivitySummaryState,
} from "@ericsanchezok/synergy-util/activity"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import { resolveAttachmentPresentation } from "./attachment-card-utils"
import type { IconName } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { timelineItemStableKey, type SessionTurnTimelineItem } from "./session-turn-timeline-item"
export { resolveActivityDisplay }
export type { ActivityDisplayMode, ActivityFamily }
export type ActivityGroupState = "running" | "error" | "waiting-approval" | "done"

export type ActivityStepPreview =
  | { kind: "output-text"; text: string }
  | { kind: "command-tail"; text: string }
  | { kind: "search-hits"; text: string }
  | { kind: "diff-excerpt"; text: string }
  | { kind: "attachments"; files: AttachmentPart[] }
  | { kind: "task-summary"; text: string }
  | { kind: "json-fallback"; text: string }

export type ActivityStepProjection = {
  part: ToolPart
  family: ActivityFamily
  scopeKey: string
  icon: IconName
  title: string | MessageDescriptor
  subtitle?: string
  state: ActivityGroupState
  permission?: PermissionRequest
  error?: string
  preview?: ActivityStepPreview
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
  scopeLabel?: string
  state: ActivityGroupState
  steps: ActivityStepProjection[]
  receipt: boolean
  summary?: ActivityTextSummary
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

const PREVIEW_LIMIT = 360
const RENDER_BOUNDARY_TOOLS = new Set(["render", "diagram"])

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

function truncate(value: string, limit = PREVIEW_LIMIT): string {
  const text = value.trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}

function truncateTail(value: string, limit = PREVIEW_LIMIT): string {
  const text = value.trim()
  if (text.length <= limit) return text
  return `…${text.slice(-(limit - 1))}`
}

function jsonFallback(value: unknown): string | undefined {
  if (value == null) return undefined
  try {
    const text = JSON.stringify(value, null, 2)
    return text ? truncate(text) : undefined
  } catch {
    return undefined
  }
}

function previewForStep(
  part: ToolPart,
  family: ActivityFamily,
  input: Record<string, unknown>,
): ActivityStepPreview | undefined {
  if (part.state.status === "completed" && part.state.attachments?.length) {
    const files = part.state.attachments.filter((file) => !resolveAttachmentPresentation(file).hidden)
    if (files.length > 0) return { kind: "attachments", files }
  }

  if (part.state.status === "error") return undefined

  if (part.state.status === "completed") {
    const output = family === "execute" ? truncateTail(part.state.output) : truncate(part.state.output)
    if (output) {
      if (family === "execute") return { kind: "command-tail", text: output }
      if (family === "inspect-local" || family === "research-web") return { kind: "search-hits", text: output }
      if (family === "modify-files") return { kind: "diff-excerpt", text: output }
      if (family === "delegate") return { kind: "task-summary", text: output }
      return { kind: "output-text", text: output }
    }
  }

  if (family === "external-action" || family === "produce" || family === "coordination") return undefined
  const fallback = jsonFallback(input)
  return fallback ? { kind: "json-fallback", text: fallback } : undefined
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
  return (
    item.kind === "part" &&
    item.part.type === "tool" &&
    !RENDER_BOUNDARY_TOOLS.has(item.part.tool) &&
    !isToolRenderBoundary(item.part.tool)
  )
}

function hasStableInput(part: ToolPart): boolean {
  if (part.state.status !== "pending" && part.state.status !== "generating") return true
  return Object.keys(part.state.input).length > 0
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
    permission,
    error: part.state.status === "error" ? part.state.error : undefined,
    preview: previewForStep(part, family, input),
  }
}

function activityMetadata(message: AssistantMessage): ActivityDerivedMetadata | undefined {
  const parsed = ActivityDerivedMetadataSchema.safeParse(message.metadata?.activity)
  return parsed.success ? parsed.data : undefined
}

function reasoningSummary(
  message: AssistantMessage,
  partID: string,
  terminal: boolean,
  metadata: ActivityDerivedMetadata | undefined,
): ActivityReasoningSummaryItem {
  const stored = metadata?.reasoning?.[partID]
  return {
    kind: "activity-reasoning-summary",
    key: `activity-reasoning:${message.id}:${partID}`,
    message,
    partID,
    state: stored?.state ?? (terminal ? "fallback" : "pending"),
    text: stored?.text,
    source: stored?.source,
  }
}

function makeGroup(message: AssistantMessage, step: ActivityStepProjection, receipt: boolean): ActivityGroupItem {
  return {
    kind: "activity-group",
    key: activityGroupKey(message.id, step.family, step.scopeKey, step.part.id),
    message,
    family: step.family,
    scopeKey: step.scopeKey,
    scopeLabel: step.subtitle,
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
  const visibleByIdentity = new Map(input.visibleItems.map((item) => [timelineItemIdentity(item), item]))
  const visibleIdentities = new Set(visibleByIdentity.keys())
  const metadata = activityMetadata(input.message)
  let pendingGroup: ActivityGroupItem | undefined

  const flush = () => {
    if (!pendingGroup) return
    pendingGroup.state = groupState(pendingGroup.steps)
    const stored = metadata?.groups?.[pendingGroup.key]
    if (stored?.text) pendingGroup.summary = { state: stored.state, text: stored.text }
    result.push(pendingGroup)
    pendingGroup = undefined
  }

  for (const source of input.sourceItems) {
    if (!isOrdinaryTool(source, input.isToolRenderBoundary ?? (() => false))) {
      flush()
      const visible = visibleByIdentity.get(timelineItemIdentity(source))
      if (!visible) continue
      if (source.kind === "reasoning") {
        result.push(reasoningSummary(input.message, source.part.id, visible.kind === "part", metadata))
        continue
      }
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
    const step = makeStep(input.message, source.part, input.permissions, input.resolveToolInfo)
    const receipt = isActivityReceiptTool(source.part.tool, step.family)
    const canMerge =
      !receipt &&
      pendingGroup &&
      !pendingGroup.receipt &&
      pendingGroup.steps.length < MAX_ACTIVITY_GROUP_STEPS &&
      pendingGroup.family === step.family &&
      pendingGroup.scopeKey === step.scopeKey

    if (canMerge && pendingGroup) {
      pendingGroup.steps.push(step)
      pendingGroup.state = groupState(pendingGroup.steps)
      continue
    }

    flush()
    pendingGroup = makeGroup(input.message, step, receipt)
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
    counts.set(group.family, (counts.get(group.family) ?? 0) + group.steps.length)
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
