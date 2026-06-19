import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"

export interface DagSummary {
  total: number
  completed: number
  running: number
  pending: number
  blocked: number
  failed: number
  ready: string[]
  progressRatio: number
}

export interface TodoItem {
  id: string
  content: string
  status: string
  priority?: string
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
export type ProgressLifecycle = "active" | "paused" | "settled"

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
  progressRatio: number
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
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
        break
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
    ready,
    progressRatio,
  }
}

export function computeTodoSummary(todos: TodoItem[]): TodoSummary {
  let total = 0
  let completed = 0
  let inProgress = 0
  let pending = 0
  let cancelled = 0

  for (const todo of todos) {
    total++
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

  const denominator = total - cancelled
  const progressRatio =
    denominator === 0 ? (total === 0 ? 0 : clampRatio(completed / total)) : clampRatio(completed / denominator)

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
  lifecycle: ProgressLifecycle = "active",
): ProgressIslandSnapshot {
  const dagHasAttention = dag != null && (dag.failed > 0 || dag.blocked > 0)
  const includeDag = mode !== "todo" && dag != null && dag.total > 0 && (lifecycle !== "paused" || dagHasAttention)
  const includeTodo = mode !== "dag" && todo != null && todo.total > 0

  const total = (includeDag ? dag!.total : 0) + (includeTodo ? todo!.total : 0)
  if (total === 0) {
    return {
      status: "hidden",
      tone: "neutral",
      completed: 0,
      total: 0,
      active: 0,
      pending: 0,
      blocked: 0,
      failed: 0,
      progressRatio: 0,
    }
  }

  const completed = (includeDag ? dag!.completed : 0) + (includeTodo ? todo!.completed : 0)
  const active = (includeDag ? dag!.running : 0) + (includeTodo ? todo!.inProgress : 0)
  const pending = (includeDag ? dag!.pending : 0) + (includeTodo ? todo!.pending : 0)
  const blocked = includeDag ? dag!.blocked : 0
  const failed = includeDag ? dag!.failed : 0
  const progressRatio = clampRatio(completed / total)

  if (lifecycle === "paused" && !dagHasAttention && active === 0) {
    return {
      status: "hidden",
      tone: "neutral",
      completed: 0,
      total: 0,
      active: 0,
      pending: 0,
      blocked: 0,
      failed: 0,
      progressRatio: 0,
    }
  }

  if (failed > 0) {
    return { status: "attention", tone: "failed", completed, total, active, pending, blocked, failed, progressRatio }
  }
  if (blocked > 0) {
    return { status: "attention", tone: "blocked", completed, total, active, pending, blocked, failed, progressRatio }
  }
  if (completed >= total) {
    return {
      status: "complete",
      tone: "complete",
      completed,
      total,
      active,
      pending,
      blocked,
      failed,
      progressRatio: 1,
    }
  }
  if (active > 0) {
    return { status: "active", tone: "running", completed, total, active, pending, blocked, failed, progressRatio }
  }

  return { status: "active", tone: "ready", completed, total, active, pending, blocked, failed, progressRatio }
}

export function formatProgressIslandLabel(snapshot: ProgressIslandSnapshot, activeLabel?: string): string {
  if (snapshot.status === "hidden") return ""
  if (snapshot.status === "complete") return `Done · ${pluralize(snapshot.total, "task")}`
  if (snapshot.tone === "failed") return `Needs attention · ${pluralize(snapshot.failed, "failed")}`
  if (snapshot.tone === "blocked") return `Needs attention · ${pluralize(snapshot.blocked, "blocked")}`

  const progress = `${snapshot.completed}/${snapshot.total}`
  const label = activeLabel?.trim()
  if (label) return `${label} · ${progress}`
  if (snapshot.tone === "ready") return `Ready · ${progress}`
  if (snapshot.active > 1) return `Working ${pluralize(snapshot.active, "task")} · ${progress}`
  return `Working · ${progress}`
}
