import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"

export interface DagSummary {
  total: number
  completed: number
  running: number
  pending: number
  blocked: number
  failed: number
  cancelled: number
  ready: string[]
  activeNodeIds: string[]
  attentionLevel: "none" | "running" | "blocked" | "failed"
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
  activeTodoIds: string[]
  progressRatio: number
}

export type ProgressMode = "none" | "dag" | "todo" | "both"

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

  const activeNodeIds: string[] = []
  const pendingNodeIds: string[] = []
  const completedNodeIds: string[] = []

  for (const node of nodes) {
    total++
    switch (node.status) {
      case "completed":
        completed++
        completedNodeIds.push(node.id)
        break
      case "running":
        running++
        activeNodeIds.push(node.id)
        break
      case "pending":
        pending++
        pendingNodeIds.push(node.id)
        break
      case "blocked":
        blocked++
        activeNodeIds.push(node.id)
        break
      case "failed":
        failed++
        activeNodeIds.push(node.id)
        break
      case "cancelled":
        cancelled++
        break
    }
  }

  const readySatisfied = new Set(completedNodeIds)
  const ready: string[] = []
  for (const nodeId of pendingNodeIds) {
    const node = nodes.find((n) => n.id === nodeId)!
    if (node.deps.every((dep) => readySatisfied.has(dep))) {
      ready.push(nodeId)
    }
  }

  let attentionLevel: DagSummary["attentionLevel"] = "none"
  if (failed > 0) attentionLevel = "failed"
  else if (blocked > 0) attentionLevel = "blocked"
  else if (running > 0) attentionLevel = "running"

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
    activeNodeIds,
    attentionLevel,
    progressRatio,
  }
}

export function computeTodoSummary(todos: TodoItem[]): TodoSummary {
  let total = 0
  let completed = 0
  let inProgress = 0
  let pending = 0
  let cancelled = 0
  const activeTodoIds: string[] = []

  for (const todo of todos) {
    total++
    switch (todo.status) {
      case "completed":
        completed++
        break
      case "in_progress":
        inProgress++
        activeTodoIds.push(todo.id)
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
    activeTodoIds,
    progressRatio,
  }
}

export function computeProgressMode(hasDag: boolean, hasTodo: boolean): ProgressMode {
  if (hasDag && hasTodo) return "both"
  if (hasDag) return "dag"
  if (hasTodo) return "todo"
  return "none"
}

export function formatProgressText(completed: number, total: number): string {
  if (completed >= total && total > 0) return "complete"
  return `${completed}/${total}`
}

export function formatRailText(mode: ProgressMode, dag?: DagSummary, todo?: TodoSummary): string {
  function dagLine(d: DagSummary): string {
    const progress = formatProgressText(d.completed, d.total)
    const indicator = d.attentionLevel !== "none" ? ` · ${d.attentionLevel}` : ""
    return `DAG ${progress}${indicator}`
  }

  function todoLine(t: TodoSummary): string {
    return `Todo ${formatProgressText(t.completed, t.total)}`
  }

  const hasDag = dag && dag.total > 0
  const hasTodo = todo && todo.total > 0

  if (mode === "none") return ""

  if (mode === "dag") {
    return hasDag ? dagLine(dag!) : ""
  }
  if (mode === "todo") {
    return hasTodo ? todoLine(todo!) : ""
  }
  if (mode === "both") {
    if (hasDag && hasTodo) return `${dagLine(dag!)} · ${todoLine(todo!)}`
    if (hasDag) return dagLine(dag!)
    if (hasTodo) return todoLine(todo!)
    return ""
  }

  return ""
}
