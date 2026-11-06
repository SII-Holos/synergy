import { MAX_ACTIVITY_GROUP_STEPS, type ActivityDisplayMode } from "@ericsanchezok/synergy-util/activity"
import type {
  ActivityBatchItem,
  ActivityBatchEntry,
  ActivityGroupItem,
  ActivityStepProjection,
  ActivityTimelineItem,
} from "./session-turn-activity"
import { isActivityTimelineItem } from "./session-turn-activity"

const batches = new WeakMap<ActivityGroupItem, { sources: ActivityTimelineItem[]; batch: ActivityBatchItem }>()

function state(steps: readonly ActivityStepProjection[]): ActivityBatchItem["state"] {
  if (steps.some((step) => step.state === "waiting-approval")) return "waiting-approval"
  if (steps.some((step) => step.state === "running")) return "running"
  if (steps.some((step) => step.state === "error")) return "error"
  return "done"
}

export function projectActivityBatches<T>(items: readonly (ActivityTimelineItem | T)[]): (ActivityTimelineItem | T)[] {
  const result: (ActivityTimelineItem | T)[] = []
  let groups: ActivityGroupItem[] = []
  let sources: ActivityTimelineItem[] = []
  let entries: ActivityBatchEntry[] = []
  let scope = ""
  const flush = () => {
    if (!groups.length) return
    const first = groups[0]
    const cached = batches.get(first)
    if (
      cached &&
      cached.sources.length === sources.length &&
      sources.every((source, index) => source === cached.sources[index])
    ) {
      result.push(cached.batch)
      groups = []
      sources = []
      entries = []
      scope = ""
      return
    }
    const steps = groups.flatMap((group) => group.steps)
    const counts = new Map<ActivityStepProjection["family"], number>()
    for (const step of steps) if (step.state === "done") counts.set(step.family, (counts.get(step.family) ?? 0) + 1)
    const inspections = steps.filter((step) => step.family === "inspect-local" && step.state === "done")
    const reads = inspections.filter((step) => ["read", "view_file"].includes(step.part.tool))
    const searches = inspections.filter(
      (step) =>
        step.part.activityEvidence?.kind === "search" ||
        ["grep", "glob", "file_search", "scan_files", "ast_grep"].includes(step.part.tool),
    )
    const knownReads =
      reads.length > 0 &&
      reads.every(
        (step) => !!step.part.activityEvidence?.resource?.path && !!step.part.activityEvidence?.resource?.workspaceID,
      )
    const fileReads = knownReads
      ? new Set(
          reads.map(
            (step) =>
              `${step.part.activityEvidence?.resource?.workspaceID}:${step.part.activityEvidence?.resource?.generation}:${step.part.activityEvidence?.resource?.path}`,
          ),
        ).size
      : undefined
    const batch: ActivityBatchItem = {
      kind: "activity-batch",
      key: `activity-batch:${first.message.id}:${steps[0].part.id}`,
      message: first.message,
      steps,
      entries,
      facts: [...counts].map(([family, count]) => ({ family, count })),
      state: state(steps),
      failures: steps.filter((step) => step.state === "error").length,
      fileReads,
      fileReadOperations: reads.length || undefined,
      searchOperations: searches.length,
      inspectionOperations: inspections.length - reads.length - searches.length,
    }
    result.push(batch)
    batches.set(first, { sources, batch })
    groups = []
    sources = []
    entries = []
    scope = ""
  }
  for (const item of items) {
    if (isActivityTimelineItem(item) && item.kind === "activity-reasoning-summary") {
      if (!groups.length) result.push(item)
      else {
        sources.push(item)
        entries.push({ kind: "reasoning", item })
      }
      continue
    }
    if (
      !isActivityTimelineItem(item) ||
      item.kind !== "activity-group" ||
      item.receipt ||
      item.steps.some((step) => step.state === "waiting-approval")
    ) {
      flush()
      result.push(item)
      continue
    }
    if (groups.length && scope && item.scopeKey && scope !== item.scopeKey) flush()
    groups.push(item)
    sources.push(item)
    entries.push(...item.steps.map((step): ActivityBatchEntry => ({ kind: "tool", step })))
    if (item.scopeKey) scope = item.scopeKey
  }
  flush()
  return result
}

export function activityBatchCurrentSteps(batch: ActivityBatchItem, active: boolean): string[] {
  if (!active) return []
  const running = batch.steps.filter((step) => step.state === "running" || step.state === "waiting-approval")
  return (running.length ? running : batch.steps.slice(-1)).map((step) => step.part.id)
}

export function activityBatchWindow(batch: ActivityBatchItem, end?: number, retained: readonly string[] = []) {
  const total = batch.steps.length
  const last = Math.min(total, Math.max(1, end ?? total))
  const first = Math.max(0, last - MAX_ACTIVITY_GROUP_STEPS)
  const included = new Set([...batch.steps.slice(first, last).map((step) => step.part.id), ...retained])
  return { first, last, total, steps: batch.steps.filter((step) => included.has(step.part.id)) }
}

export function resolveActivityDisclosure(input: {
  mode: ActivityDisplayMode
  working: boolean
  heldOpen: boolean
  explicit?: boolean
}): boolean {
  if (input.explicit !== undefined) return input.explicit
  if (input.mode === "full") return true
  if (input.mode === "minimal") return false
  return input.working || input.heldOpen
}
