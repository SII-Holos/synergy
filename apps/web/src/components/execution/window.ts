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

export function mergeExecutionWindow(
  current: readonly ExecutionTrajectoryNode[],
  incoming: readonly ExecutionTrajectoryNode[],
  removed: readonly string[],
  options: {
    history: boolean
    cap?: number
    compare?: (a: ExecutionTrajectoryNode, b: ExecutionTrajectoryNode) => number
  },
) {
  const deleted = new Set(removed)
  const rows = new Map(current.filter((row) => !deleted.has(row.id)).map((row) => [row.id, row]))
  let added = 0
  for (const row of incoming) {
    if (deleted.has(row.id)) continue
    if (!rows.has(row.id)) {
      added++
      if (options.history) continue
    }
    rows.set(row.id, row)
  }
  const sorted = [...rows.values()].sort(options.compare ?? executionOrder("time", new Map()))
  const cap = options.cap ?? 500
  return { rows: options.history ? sorted.slice(0, cap) : sorted.slice(-cap), added }
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
