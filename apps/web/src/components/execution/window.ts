import type { ExecutionTrajectoryNode } from "@ericsanchezok/synergy-sdk/client"

export function executionOrder(order: "time" | "round" | "call", rounds: ReadonlyMap<string, number>) {
  return (a: ExecutionTrajectoryNode, b: ExecutionTrajectoryNode) =>
    (order === "time"
      ? 0
      : (rounds.get(a.rootRunID === undefined ? a.runID : (a.rootRunID ?? "")) ?? Number.MAX_SAFE_INTEGER) -
        (rounds.get(b.rootRunID === undefined ? b.runID : (b.rootRunID ?? "")) ?? Number.MAX_SAFE_INTEGER)) ||
    (order === "call" ? (a.group?.started ?? a.started) - (b.group?.started ?? b.started) : 0) ||
    a.started - b.started ||
    a.id.localeCompare(b.id)
}

export type ExecutionWindowMerge = {
  rows: ExecutionTrajectoryNode[]
  addedIds: string[]
  droppedIds: string[]
}

export function capExecutionRows<T extends { id: string }>(rows: readonly T[], cap: number) {
  const limit = Math.max(0, cap)
  if (rows.length <= limit) return { rows: [...rows], droppedIds: [] as string[] }
  return {
    rows: rows.slice(rows.length - limit),
    droppedIds: rows.slice(0, rows.length - limit).map((row) => row.id),
  }
}

export function mergeExecutionWindow(
  current: readonly ExecutionTrajectoryNode[],
  incoming: readonly ExecutionTrajectoryNode[],
  removed: readonly string[],
  options: {
    history: boolean
    cap?: number
    compare?: (a: ExecutionTrajectoryNode, b: ExecutionTrajectoryNode) => number
  },
): ExecutionWindowMerge {
  const deleted = new Set(removed)
  const rows = new Map(current.filter((row) => !deleted.has(row.id)).map((row) => [row.id, row]))
  const addedIds: string[] = []
  const counted = new Set<string>()
  for (const row of incoming) {
    if (deleted.has(row.id)) continue
    if (!rows.has(row.id)) {
      if (!counted.has(row.id)) {
        counted.add(row.id)
        addedIds.push(row.id)
      }
      if (options.history) continue
    }
    rows.set(row.id, row)
  }
  const sorted = [...rows.values()].sort(options.compare ?? executionOrder("time", new Map()))
  const capped = capExecutionRows(sorted, options.cap ?? 500)
  return { rows: capped.rows, addedIds, droppedIds: capped.droppedIds }
}

export function capExecutionBranchWindow<T extends { rows: readonly { id: string }[]; previous?: boolean }>(
  branches: ReadonlyMap<string, T>,
  cap: number,
): { branches: Map<string, T>; droppedIds: string[] } {
  const next = new Map<string, T>()
  let count = 0
  for (const branch of branches.values()) count += branch.rows.length
  const droppedIds: string[] = []
  for (const [key, branch] of branches) {
    if (count <= cap) {
      next.set(key, branch)
      continue
    }
    const removed = Math.min(count - Math.max(0, cap), branch.rows.length)
    if (!removed) {
      next.set(key, branch)
      continue
    }
    droppedIds.push(...branch.rows.slice(0, removed).map((row) => row.id))
    next.set(key, { ...branch, rows: branch.rows.slice(removed), previous: true })
    count -= removed
  }
  return { branches: next, droppedIds }
}

export function retainExecutionPendingIds(
  pendingIds: readonly string[],
  input: {
    rows: readonly { id: string }[]
    addedIds: readonly string[]
    removedIds: readonly string[]
    droppedIds: readonly string[]
    withhold: boolean
  },
) {
  const removed = new Set(input.removedIds)
  const dropped = new Set(input.droppedIds)
  const visible = new Set(input.rows.map((row) => row.id))
  const pending: string[] = []
  const seen = new Set<string>()
  const keep = (id: string) => {
    if (removed.has(id) || dropped.has(id) || visible.has(id) || seen.has(id)) return
    seen.add(id)
    pending.push(id)
  }
  for (const id of pendingIds) keep(id)
  if (input.withhold) for (const id of input.addedIds) keep(id)
  return pending
}

export function executionWindowMatches(
  row: ExecutionTrajectoryNode,
  input: {
    sessionID: string
    actor?: string
    kind?: string
    status?: string
    query?: string
    runs?: ReadonlySet<string>
    parents?: ReadonlyMap<string, string | null>
  },
) {
  if (input.runs && !input.runs.has(row.sessionID + ":" + row.runID)) return false
  if (input.actor && input.actor !== "all" && row.sessionID !== input.actor) return false
  if (
    !input.actor &&
    row.sessionID !== input.sessionID &&
    (row.kind !== "subtask" || (input.parents && input.parents.get(row.sessionID) !== input.sessionID))
  )
    return false
  if ((input.kind && row.kind !== input.kind) || (input.status && row.status !== input.status)) return false
  const query = input.query?.trim().toLocaleLowerCase()
  return (
    !query ||
    (row.title + " " + row.preview + " " + (row.tool ?? "") + " " + (row.agent ?? ""))
      .toLocaleLowerCase()
      .includes(query)
  )
}
