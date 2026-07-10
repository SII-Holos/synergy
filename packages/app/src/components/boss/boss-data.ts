import type {
  WorkflowRun,
  WorkflowEntity,
  WorkflowEvent,
  WorkflowGateInstance,
} from "@ericsanchezok/synergy-sdk/client"

/**
 * Pure data helpers for the Boss panel. Kept side-effect free so they can be
 * unit-tested without the SolidJS runtime or a live SDK.
 */
export namespace BossData {
  /** Merge newly-arrived events into an existing list, de-duplicating by id and keeping chronological order. */
  export function mergeEvents(existing: WorkflowEvent[], incoming: WorkflowEvent[]): WorkflowEvent[] {
    const byID = new Map<string, WorkflowEvent>()
    for (const e of existing) byID.set(e.id, e)
    for (const e of incoming) byID.set(e.id, e)
    return [...byID.values()].sort((a, b) => a.time.created - b.time.created)
  }

  /** Group a run's entities by state, in the order the states appear (blocked last). */
  export function entitiesByState(
    run: WorkflowRun,
    stateOrder: string[],
  ): { state: string; entities: WorkflowEntity[] }[] {
    const groups = new Map<string, WorkflowEntity[]>()
    for (const entity of run.entities) {
      const list = groups.get(entity.state) ?? []
      list.push(entity)
      groups.set(entity.state, list)
    }
    const seen = new Set<string>()
    const ordered: { state: string; entities: WorkflowEntity[] }[] = []
    const push = (state: string) => {
      if (seen.has(state)) return
      seen.add(state)
      ordered.push({ state, entities: groups.get(state) ?? [] })
    }
    for (const state of stateOrder) if (state !== "blocked") push(state)
    // Any states not in the declared order (defensive) then blocked last.
    for (const state of groups.keys()) if (state !== "blocked") push(state)
    if (groups.has("blocked")) ordered.push({ state: "blocked", entities: groups.get("blocked") ?? [] })
    return ordered
  }

  export function pendingGates(run: WorkflowRun): WorkflowGateInstance[] {
    return run.gates.filter((g) => g.status === "pending")
  }

  export function isActive(run: WorkflowRun): boolean {
    return run.status === "active" || run.status === "paused"
  }

  export function eventTone(kind: WorkflowEvent["kind"]): "error" | "warn" | "default" {
    if (kind === "guard_failed" || kind === "effect_failed" || kind === "entity_blocked" || kind === "run_failed") {
      return "error"
    }
    if (kind === "budget_exhausted" || kind === "run_paused") return "warn"
    return "default"
  }

  export function eventLabel(event: WorkflowEvent): string {
    const base = event.kind.replace(/_/g, " ")
    if (event.message) return `${base}: ${event.message}`
    return base
  }
}
