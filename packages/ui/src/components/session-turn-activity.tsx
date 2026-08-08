import type { MessageDescriptor } from "@lingui/core"
import type { AssistantMessage, AttachmentPart, PermissionRequest, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import type { IconName } from "./icon"
import { timelineItemStableKey, type SessionTurnTimelineItem } from "./session-turn-timeline-item"
import { classifyTool, type SemanticCategory } from "./tool/classifier"

export type ActivityDisplayMode = "full" | "balanced" | "minimal"

export type ActivityFamily =
  | "inspect-local"
  | "research-web"
  | "modify-files"
  | "execute"
  | "browser"
  | "delegate"
  | "produce"
  | "external-action"
  | "coordination"
  | "generic"

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
}

export type ActivityReceiptItem = {
  kind: "activity-receipt"
  key: string
  message: AssistantMessage
  group: ActivityGroupItem
}

export type ActivityPassthroughItem = {
  kind: "passthrough"
  item: SessionTurnTimelineItem
  message: AssistantMessage
}

export type ActivityTimelineItem =
  | ActivityGroupItem
  | ActivitySummaryItem
  | ActivityReceiptItem
  | ActivityPassthroughItem

const ACTIVITY_FAMILIES = new Set<ActivityFamily>([
  "inspect-local",
  "research-web",
  "modify-files",
  "execute",
  "browser",
  "delegate",
  "produce",
  "external-action",
  "coordination",
  "generic",
])

export const ACTIVITY_FAMILY_ORDER: readonly ActivityFamily[] = [
  "inspect-local",
  "research-web",
  "modify-files",
  "execute",
  "browser",
  "delegate",
  "produce",
  "external-action",
  "coordination",
  "generic",
]

const EXTERNAL_ACTION_TOOLS = new Set([
  "email_send",
  "email_mark_read",
  "session_send",
  "clarus_submit_task_result",
  "clarus_extend_task",
  "github_deliver_fix",
  "question",
  "agenda_schedule",
  "agenda_update",
  "agenda_cancel",
  "calendar_create",
  "calendar_update",
  "calendar_delete",
])

const PRODUCTION_COMMUNICATION_TOOLS = new Set([
  "attach",
  "response_card",
  "openai_image_gen",
  "openai_image_edit",
  "generate_image",
  "edit_image",
])

const RENDER_BOUNDARY_TOOLS = new Set(["render", "diagram"])
const COORDINATION_RECEIPT_TOOLS = new Set([
  "dagwrite",
  "dagpatch",
  "session_control",
  "agenda_trigger",
  "task_cancel",
  "loop_stop",
  "light_loop_approve",
  "light_loop_reject",
  "blueprint_loop_approve",
  "blueprint_loop_reject",
  "blueprint_loop_stop",
])
const HIDDEN_COORDINATION_TOOLS = new Set(["dagread"])
const MAX_GROUP_STEPS = 24
const PREVIEW_LIMIT = 360

export function resolveActivityDisplay(value: unknown): ActivityDisplayMode {
  return value === "full" || value === "minimal" || value === "balanced" ? value : "balanced"
}

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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const text = value.trim()
    if (text) return text
  }
  return undefined
}

function pathScope(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  const slash = normalized.lastIndexOf("/")
  if (slash <= 0) return normalized
  return normalized.slice(0, slash)
}

function urlScope(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return parsed.origin
  } catch {
    return undefined
  }
}

function scopeForTool(part: ToolPart, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const explicit = firstString(metadata.activityScope, metadata.scopeKey)
  if (explicit) return { key: `scope:${explicit}`, label: explicit }

  const file = firstString(
    input.filePath,
    input.file_path,
    input.outputPath,
    input.output_path,
    input.filename,
    input.path,
    metadata.filePath,
    metadata.path,
  )
  if (file) {
    const scope = pathScope(file)
    return { key: `path:${scope}`, label: scope }
  }

  const url = firstString(input.url, input.href, input.endpoint, metadata.url, metadata.href)
  if (url) {
    const origin = urlScope(url)
    if (origin) return { key: `url:${origin}`, label: origin }
  }

  const page = firstString(input.pageID, input.pageId, input.targetID, metadata.pageID, metadata.targetID)
  if (page) return { key: `page:${page}`, label: page }

  const task = firstString(
    input.task_id,
    input.taskID,
    input.session_id,
    input.sessionID,
    input.id,
    metadata.task_id,
    metadata.taskID,
  )
  if (task) return { key: `task:${task}`, label: task }

  const artifact = firstString(input.name, input.title, input.outputItem, metadata.name, metadata.title)
  if (artifact) return { key: `artifact:${artifact}`, label: artifact }

  return { key: "", label: undefined }
}

function metadataFamily(metadata: Record<string, unknown>): ActivityFamily | undefined {
  const display = record(metadata.display)
  const value = firstString(metadata.activityFamily, display.activityFamily)
  return value && ACTIVITY_FAMILIES.has(value as ActivityFamily) ? (value as ActivityFamily) : undefined
}

function familyForCategory(
  tool: string,
  category: SemanticCategory,
  metadata: Record<string, unknown>,
): ActivityFamily {
  if (EXTERNAL_ACTION_TOOLS.has(tool)) return "external-action"
  if (PRODUCTION_COMMUNICATION_TOOLS.has(tool)) return "produce"
  if (COORDINATION_RECEIPT_TOOLS.has(tool)) return "coordination"
  const override = metadataFamily(metadata)
  if (override) return override

  switch (category) {
    case "file-read":
    case "search":
    case "memory":
      return "inspect-local"
    case "web":
    case "research":
      return "research-web"
    case "file-write":
      return "modify-files"
    case "shell":
      return "execute"
    case "browser":
      return "browser"
    case "task":
      return "delegate"
    case "analyze":
    case "note":
    case "blueprint":
      return "produce"
    case "communication":
      return "external-action"
    case "dag":
    case "schedule":
    case "session":
    case "session-control":
    case "network":
    case "config":
    case "skill":
    case "community":
      return "coordination"
    case "generic":
      return "generic"
  }
}

function truncate(value: string, limit = PREVIEW_LIMIT): string {
  const text = value.trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
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
    return { kind: "attachments", files: part.state.attachments }
  }

  if (part.state.status === "error") return undefined

  if (part.state.status === "completed") {
    const output = truncate(part.state.output)
    if (output) {
      if (family === "execute") return { kind: "command-tail", text: output }
      if (family === "inspect-local" || family === "research-web") return { kind: "search-hits", text: output }
      if (family === "modify-files") return { kind: "diff-excerpt", text: output }
      if (family === "delegate") return { kind: "task-summary", text: output }
      return { kind: "output-text", text: output }
    }
  }

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

function isOrdinaryTool(item: SessionTurnTimelineItem): item is Extract<SessionTurnTimelineItem, { kind: "part" }> & {
  part: ToolPart
} {
  return item.kind === "part" && item.part.type === "tool" && !RENDER_BOUNDARY_TOOLS.has(item.part.tool)
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
  const classified = classifyTool(part.tool, input, metadata)
  const family = familyForCategory(part.tool, classified.category, metadata)
  const scope = scopeForTool(part, input, metadata)
  const info = resolveToolInfo(part.tool, input, metadata)
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

function groupKey(messageID: string, family: ActivityFamily, scopeKey: string, firstPartID: string): string {
  return `activity:${messageID}:${family}:${scopeKey}:${firstPartID}`
}

function makeGroup(message: AssistantMessage, step: ActivityStepProjection, receipt: boolean): ActivityGroupItem {
  return {
    kind: "activity-group",
    key: groupKey(message.id, step.family, step.scopeKey, step.part.id),
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
}): ActivityTimelineItem[] {
  const result: ActivityTimelineItem[] = []
  const visibleByIdentity = new Map(input.visibleItems.map((item) => [timelineItemIdentity(item), item]))
  const visibleIdentities = new Set(visibleByIdentity.keys())
  let pendingGroup: ActivityGroupItem | undefined

  const flush = () => {
    if (!pendingGroup) return
    pendingGroup.state = groupState(pendingGroup.steps)
    result.push(pendingGroup)
    pendingGroup = undefined
  }

  for (const source of input.sourceItems) {
    if (!isOrdinaryTool(source)) {
      flush()
      const visible = visibleByIdentity.get(timelineItemIdentity(source))
      if (visible) result.push({ kind: "passthrough", item: visible, message: input.message })
      continue
    }

    if (HIDDEN_COORDINATION_TOOLS.has(source.part.tool)) {
      flush()
      continue
    }

    if (!isVisible(source, visibleIdentities)) {
      flush()
      continue
    }

    if (!hasStableInput(source.part)) {
      flush()
      continue
    }
    const step = makeStep(input.message, source.part, input.permissions, input.resolveToolInfo)
    const receipt = step.family === "external-action" || COORDINATION_RECEIPT_TOOLS.has(source.part.tool)
    const canMerge =
      !receipt &&
      pendingGroup &&
      !pendingGroup.receipt &&
      pendingGroup.steps.length < MAX_GROUP_STEPS &&
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
    kind === "activity-group" || kind === "activity-summary" || kind === "activity-receipt" || kind === "passthrough"
  )
}

function receiptForGroup(group: ActivityGroupItem, step?: ActivityStepProjection): ActivityReceiptItem {
  const receiptGroup = step
    ? {
        ...group,
        key: groupKey(group.message.id, group.family, group.scopeKey, step.part.id),
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
    return items.flatMap((item) => {
      if (!isActivityTimelineItem(item) || item.kind !== "activity-group") return [item]
      return explicitReceipts(item)
    })
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
  const first = groups[0]
  const summary: ActivitySummaryItem = {
    kind: "activity-summary",
    key: `activity-summary:${rootMessageID}`,
    message: first.message,
    total,
    facts,
    completed,
  }
  let inserted = false
  const result: (ActivityTimelineItem | T)[] = []
  for (const item of items) {
    if (!isActivityTimelineItem(item) || item.kind !== "activity-group") {
      result.push(item)
      continue
    }
    if (!inserted && !item.receipt) {
      result.push(summary)
      inserted = true
    }
    result.push(...explicitReceipts(item))
  }
  return result
}
