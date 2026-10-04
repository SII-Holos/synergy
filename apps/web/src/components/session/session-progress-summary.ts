import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"
import type { Todo } from "@ericsanchezok/synergy-sdk/client"

export interface DagSummary {
  total: number
  completed: number
  running: number
  pending: number
  blocked: number
  failed: number
  ready: string[]
  cancelled: number
  progressRatio: number
}

export interface TodoSummary {
  total: number
  completed: number
  inProgress: number
  pending: number
  cancelled: number
  progressRatio: number
}

export type ProgressMode = "none" | "dag" | "todo" | "both"

export type ProgressIslandStatus = "hidden" | "active" | "attention" | "complete"
export type ProgressIslandTone = "neutral" | "ready" | "running" | "blocked" | "failed" | "complete"

export interface ProgressIslandSnapshot {
  status: ProgressIslandStatus
  tone: ProgressIslandTone
  completed: number
  total: number
  active: number
  pending: number
  blocked: number
  failed: number
  cancelled: number
  progressRatio: number
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100))
}

export function computeDagSummary(nodes: DagNode[]): DagSummary {
  let total = 0
  let completed = 0
  let running = 0
  let pending = 0
  let blocked = 0
  let failed = 0
  let cancelled = 0
  const pendingNodeIds: string[] = []
  const completedNodeIds: string[] = []
  const nodeById = new Map<string, DagNode>()

  for (const node of nodes) {
    nodeById.set(node.id, node)
    switch (node.status) {
      case "completed":
        total++
        completed++
        completedNodeIds.push(node.id)
        break
      case "running":
        total++
        running++
        break
      case "pending":
        total++
        pending++
        pendingNodeIds.push(node.id)
        break
      case "blocked":
        total++
        blocked++
        break
      case "failed":
        total++
        failed++
        break
      case "cancelled":
        cancelled++
        break
      default:
        total++
    }
  }

  const readySatisfied = new Set(completedNodeIds)
  const ready: string[] = []
  for (const nodeId of pendingNodeIds) {
    const node = nodeById.get(nodeId)!
    if (node.deps.every((dep) => readySatisfied.has(dep))) {
      ready.push(nodeId)
    }
  }

  const progressRatio = total === 0 ? 0 : clampRatio(completed / total)

  return {
    total,
    completed,
    running,
    pending,
    blocked,
    failed,
    cancelled,
    ready,
    progressRatio,
  }
}

export function computeTodoSummary(todos: readonly Todo[]): TodoSummary {
  let total = 0
  let completed = 0
  let inProgress = 0
  let pending = 0
  let cancelled = 0

  for (const todo of todos) {
    if (todo.status !== "cancelled") total++
    switch (todo.status) {
      case "completed":
        completed++
        break
      case "in_progress":
        inProgress++
        break
      case "pending":
        pending++
        break
      case "cancelled":
        cancelled++
        break
    }
  }

  const progressRatio = total === 0 ? 0 : clampRatio(completed / total)

  return {
    total,
    completed,
    inProgress,
    pending,
    cancelled,
    progressRatio,
  }
}

export function computeProgressMode(hasDag: boolean, hasTodo: boolean): ProgressMode {
  if (hasDag && hasTodo) return "both"
  if (hasDag) return "dag"
  if (hasTodo) return "todo"
  return "none"
}

export function computeProgressIslandSnapshot(
  mode: ProgressMode,
  dag?: DagSummary,
  todo?: TodoSummary,
): ProgressIslandSnapshot {
  const source = mode === "none" ? undefined : mode === "dag" ? dag : (todo ?? dag)
  const total = source?.total ?? 0
  const completed = source?.completed ?? 0
  const cancelled = source?.cancelled ?? 0
  const active = source && "running" in source ? source.running : (source?.inProgress ?? 0)
  const pending = source?.pending ?? 0
  const blocked = source && "blocked" in source ? source.blocked : 0
  const failed = source && "failed" in source ? source.failed : 0
  const progressRatio = source?.progressRatio ?? 0
  const values = { total, completed, cancelled, active, pending, blocked, failed, progressRatio }
  if (total === 0 && cancelled === 0) return { ...values, status: "hidden", tone: "neutral" }
  if (completed === total) return { ...values, status: "complete", tone: "complete" }
  if (failed > 0) return { ...values, status: "attention", tone: "failed" }
  if (blocked > 0) return { ...values, status: "attention", tone: "blocked" }
  return { ...values, status: "active", tone: active > 0 ? "running" : "ready" }
}
