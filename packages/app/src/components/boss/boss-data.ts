import type {
  WorkflowRun,
  WorkflowEntity,
  WorkflowEvent,
  WorkflowGateInstance,
  WorkflowEventPage,
} from "@ericsanchezok/synergy-sdk/client"

/**
 * Pure data helpers for the Boss panel. Kept side-effect free so they can be
 * unit-tested without the SolidJS runtime or a live SDK.
 */
export namespace BossData {
  export type EventPage = WorkflowEventPage

  export interface LatestRequestHandlers<T> {
    success: (value: T) => void
    failure: (error: unknown) => void
  }

  export interface LatestRequestRunner {
    run<T>(request: (signal: AbortSignal) => Promise<T>, handlers: LatestRequestHandlers<T>): Promise<void>
    cancel(): void
  }

  export function createLatestRequestRunner(): LatestRequestRunner {
    let generation = 0
    let controller: AbortController | undefined

    return {
      async run<T>(request: (signal: AbortSignal) => Promise<T>, handlers: LatestRequestHandlers<T>) {
        controller?.abort()
        const requestController = new AbortController()
        const requestGeneration = ++generation
        controller = requestController

        let value: T
        try {
          value = await request(requestController.signal)
        } catch (error) {
          if (requestGeneration === generation && !requestController.signal.aborted) handlers.failure(error)
          return
        }

        if (requestGeneration === generation && !requestController.signal.aborted) handlers.success(value)
      },
      cancel() {
        generation += 1
        controller?.abort()
        controller = undefined
      },
    }
  }

  /** Merge newly-arrived events into an existing list, de-duplicating by id and keeping chronological order. */
  export function mergeEvents(existing: WorkflowEvent[], incoming: WorkflowEvent[]): WorkflowEvent[] {
    const byID = new Map<string, WorkflowEvent>()
    for (const e of existing) byID.set(e.id, e)
    for (const e of incoming) byID.set(e.id, e)
    return [...byID.values()].sort((a, b) => a.time.created - b.time.created)
  }

  export function mergeEventSnapshot(current: WorkflowEvent[], snapshot: WorkflowEvent[]): WorkflowEvent[] {
    return mergeEvents(snapshot, current)
  }

  export async function collectEventPages(
    fetchPage: (after?: string) => Promise<EventPage>,
    signal?: AbortSignal,
  ): Promise<WorkflowEvent[]> {
    let after: string | undefined
    let items: WorkflowEvent[] = []
    const cursors = new Set<string>()
    while (true) {
      if (signal?.aborted) throw new DOMException("Event loading was aborted", "AbortError")
      const page = await fetchPage(after)
      items = mergeEvents(items, page.items)
      const next = page.nextCursor
      if (!next) return items
      if (cursors.has(next)) throw new Error(`Workflow event cursor repeated: ${next}`)
      cursors.add(next)
      after = next
    }
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

  export function activeRunsForSession(runs: WorkflowRun[], sessionID: string | undefined): WorkflowRun[] {
    if (!sessionID) return []
    return runs.filter((run) => run.bossSessionID === sessionID && isActive(run))
  }

  function preferredRun(
    current: WorkflowRun,
    incoming: WorkflowRun,
    preserveCurrentWithoutRevision: boolean,
  ): WorkflowRun {
    const currentRevision = current.revision
    const incomingRevision = incoming.revision
    if (currentRevision !== undefined) {
      if (incomingRevision === undefined || incomingRevision < currentRevision) return current
      if (incomingRevision > currentRevision) return incoming
    }
    if (incomingRevision !== undefined) return incoming
    if (preserveCurrentWithoutRevision) return current
    return incoming
  }

  export function latestRun(current: WorkflowRun | undefined, incoming: WorkflowRun): WorkflowRun {
    return current ? preferredRun(current, incoming, false) : incoming
  }

  export function reconcileActiveRun(
    current: WorkflowRun[],
    incoming: WorkflowRun,
    sessionID: string | undefined,
  ): WorkflowRun[] {
    if (!sessionID || incoming.bossSessionID !== sessionID) return current

    const index = current.findIndex((run) => run.id === incoming.id)
    const nextRun = index === -1 ? incoming : preferredRun(current[index], incoming, false)
    if (index !== -1 && nextRun === current[index]) return current
    if (!isActive(nextRun)) {
      if (index === -1) return current
      return current.filter((run) => run.id !== incoming.id)
    }
    if (index === -1) return [...current, nextRun]

    const next = [...current]
    next[index] = nextRun
    return next
  }

  export function reconcileRunSnapshot(
    current: WorkflowRun[],
    snapshot: WorkflowRun[],
    baseline: WorkflowRun[],
    sessionID: string | undefined,
    liveChanges: WorkflowRun[] = [],
  ): WorkflowRun[] {
    if (!sessionID) return []

    const records = new Map<string, WorkflowRun>()
    const order: string[] = []
    for (const incoming of snapshot) {
      if (incoming.bossSessionID !== sessionID) continue
      if (!records.has(incoming.id)) order.push(incoming.id)
      records.set(incoming.id, latestRun(records.get(incoming.id), incoming))
    }

    const baselineByID = new Map(baseline.map((run) => [run.id, run] as const))

    for (const currentRun of current) {
      if (currentRun.bossSessionID !== sessionID) continue
      const incoming = records.get(currentRun.id)
      if (incoming) {
        records.set(currentRun.id, preferredRun(currentRun, incoming, baselineByID.get(currentRun.id) !== currentRun))
        continue
      }

      const baselineRun = baselineByID.get(currentRun.id)
      if (!baselineRun || currentRun !== baselineRun) {
        records.set(currentRun.id, currentRun)
        order.push(currentRun.id)
      }
    }

    for (const live of liveChanges) {
      if (live.bossSessionID !== sessionID) continue
      if (!records.has(live.id)) order.push(live.id)
      records.set(live.id, latestRun(records.get(live.id), live))
    }

    const ordered = order.flatMap((id) => {
      const record = records.get(id)
      return record ? [record] : []
    })
    return activeRunsForSession(ordered, sessionID)
  }

  export function selectRunID(runs: WorkflowRun[], selectedRunID: string | undefined): string | undefined {
    if (selectedRunID && runs.some((run) => run.id === selectedRunID)) return selectedRunID
    return runs[0]?.id
  }

  export function runListState(loaded: boolean, runs: WorkflowRun[]): "loading" | "empty" | "ready" {
    if (!loaded) return "loading"
    return runs.length === 0 ? "empty" : "ready"
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
