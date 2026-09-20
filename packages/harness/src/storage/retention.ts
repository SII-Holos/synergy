import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "./storage"
import { Log } from "../util/log"
import { SqliteMaintenance } from "./sqlite-maintenance"
import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityMetrics } from "../observability/metrics"

const log = Log.create({ service: "storage.retention" })

/**
 * Budgeted retention for authoritative rollout evidence.
 *
 * Pruning is off unless a window is configured, and the byte budget is a
 * backstop rather than a target: nothing is enumerated, scanned or deleted
 * while the store is inside it. A pass removes whole evidence trees
 * oldest-first and stops once the physical database is back inside its budget.
 * Two protections are absolute: a session or operation whose newest record is
 * inside the window is never touched, and a live session is never touched even
 * when its evidence is older than the window. Rollout evidence carries
 * rewind/restore/replay semantics, so a pruned tree is gone for good; both
 * protections are therefore evaluated before any delete runs.
 */
export namespace StorageRetention {
  export interface Owner {
    key: string[]
    kind: "session" | "operation"
    scopeID: string
    id: string
    newest: number
    records: number
  }

  export interface Report {
    considered: number
    protectedByWindow: number
    protectedLive: number
    pruned: Array<{ key: string[]; records: number }>
    deletedRecords: number
    releasedPages: number
    footprintBytes: number
    capped: boolean
    /** The budget cannot be reached by removing evidence the window permits
     *  removing, so another pass would delete nothing and change nothing. */
    infeasible: boolean
  }

  const SWEEP_INTERVAL_MS = 15 * 60_000
  const DEFAULT_BUDGET_MS = 500
  const RECLAIM_PAGES = 8192
  // A store that stays over budget after a pass is not converging on its own;
  // repeating the same destructive pass every tick would keep paying its cost
  // for no progress. Backing off keeps a misconfigured budget from turning into
  // a permanently running deletion loop.
  const BACKOFF_BASE_MS = 15 * 60_000
  const BACKOFF_MAX_STEPS = 4
  const runtimeState = RuntimeContext.state(() => ({
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    running: undefined as Promise<Report> | undefined,
    consecutiveCapped: 0,
    cooldownUntil: 0,
  }))

  export function isEnabled(retentionMs: number | undefined): retentionMs is number {
    return typeof retentionMs === "number" && Number.isFinite(retentionMs) && retentionMs > 0
  }

  /**
   * Runs one retention pass on a fixed cadence. The live set is resolved on
   * every pass, so a session that starts between ticks cannot be pruned by a
   * snapshot taken before it opened.
   */
  export function schedule(input: {
    current(): { retentionMs: number; maxBytes: number }
    liveSessionIDs(): string[]
  }) {
    const instanceState = runtimeState()

    stop()
    instanceState.timer = setInterval(() => {
      if (instanceState.running) return
      if (Date.now() < instanceState.cooldownUntil) return
      const config = input.current()
      if (!isEnabled(config.retentionMs)) return
      instanceState.running = run({ ...config, liveSessionIDs: input.liveSessionIDs() })
        .then((report) => {
          instanceState.consecutiveCapped = report.capped ? instanceState.consecutiveCapped + 1 : 0
          instanceState.cooldownUntil = report.capped
            ? Date.now() + BACKOFF_BASE_MS * 2 ** Math.min(instanceState.consecutiveCapped - 1, BACKOFF_MAX_STEPS)
            : 0
          return report
        })
        .catch((error) => {
          // A pass that never completes cannot reclaim anything, and the failure
          // repeats on every sweep. A log line leaves the store silently over
          // budget, so the condition is reported where an operator already looks
          // for storage problems.
          log.warn("retention pass failed", { error })
          ObservabilityIssues.raise({
            code: "STORAGE_RETENTION_PASS_FAILED",
            severity: "warning",
            module: "storage",
            title: "Retention pass failed",
            message:
              "A scheduled retention pass did not complete, so the store keeps its previous footprint and the next sweep retries the same work.",
            evidence: { errorName: error instanceof Error ? error.name : "unknown" },
          })
          return undefined as unknown as Report
        })
        .finally(() => {
          instanceState.running = undefined
        }) as Promise<Report>
    }, SWEEP_INTERVAL_MS)
    instanceState.timer.unref()
  }

  export function stop() {
    const instanceState = runtimeState()

    if (instanceState.timer) clearInterval(instanceState.timer)
    instanceState.timer = undefined
    instanceState.consecutiveCapped = 0
    instanceState.cooldownUntil = 0
  }

  export function protectedOwners(input: {
    owners: ReadonlyArray<Owner>
    retentionMs: number
    liveSessionIDs: Iterable<string>
    now?: number
  }) {
    const cutoff = (input.now ?? Date.now()) - input.retentionMs
    const live = new Set(input.liveSessionIDs)
    const candidates: Owner[] = []
    let protectedByWindow = 0
    let protectedLive = 0
    for (const owner of input.owners) {
      if (owner.kind === "session" && live.has(owner.id)) {
        protectedLive++
        continue
      }
      if (owner.newest >= cutoff) {
        protectedByWindow++
        continue
      }
      candidates.push(owner)
    }
    return { candidates, protectedByWindow, protectedLive }
  }

  /**
   * Enumerates evidence owners with the recency of their newest record. The scan
   * reads only keys and timestamps, never record bodies, so it stays bounded
   * by owner count rather than by how much evidence an owner holds; it is still
   * the single most expensive statement in a pass, which is why a pass reaches
   * it only once the store is already over budget.
   */
  export async function owners(): Promise<Owner[]> {
    const rows = await Storage.current().store.evidenceOwners()
    return rows.map((row) => ({
      key: row.keyPrefix,
      kind: row.kind === "operation" ? ("operation" as const) : ("session" as const),
      scopeID: row.scopeID,
      id: row.ownerID,
      newest: row.newest,
      records: row.records,
    }))
  }

  /**
   * Runs one retention pass. Without a configured window this is a no-op, so an
   * operator can disable pruning immediately by clearing `retentionMs`.
   */
  export async function run(input: {
    retentionMs: number | undefined
    maxBytes: number
    liveSessionIDs: Iterable<string>
    now?: number
    budgetMs?: number
  }): Promise<Report> {
    const handle = Storage.current()
    const filename = handle.store.sqliteFilename
    const footprint = () => (filename ? SqliteMaintenance.physicalFootprint(filename) : 0)
    const empty: Report = {
      considered: 0,
      protectedByWindow: 0,
      protectedLive: 0,
      pruned: [],
      deletedRecords: 0,
      releasedPages: 0,
      footprintBytes: footprint(),
      capped: false,
      infeasible: false,
    }
    if (!isEnabled(input.retentionMs)) return empty
    // The budget gates the pass, so it is read before any enumeration: an
    // over-budget recovery is the only reason to pay for the owner scan.
    const overBudget = () => !filename || footprint() > input.maxBytes
    if (!overBudget()) return empty

    const all = await owners()
    const { candidates, protectedByWindow, protectedLive } = protectedOwners({
      owners: all,
      retentionMs: input.retentionMs,
      liveSessionIDs: input.liveSessionIDs,
      now: input.now,
    })
    const report: Report = {
      ...empty,
      considered: all.length,
      protectedByWindow,
      protectedLive,
      footprintBytes: footprint(),
    }
    if (!candidates.length) {
      // Over budget with nothing the window permits removing. Deleting more
      // cannot reach this budget, so the condition is a configuration problem
      // and repeating the pass would only repeat the cost.
      report.infeasible = true
      report.capped = true
      ObservabilityIssues.raise({
        code: "STORAGE_RETENTION_BUDGET_INFEASIBLE",
        severity: "warning",
        module: "storage",
        title: "Retention budget cannot be reached",
        message:
          "Authoritative storage is over its byte budget and holds no evidence old enough to prune; raise retentionBytes or shorten the retention window.",
        recommendation:
          "Raise storage.retentionBytes above the retention window's steady-state size, or lower storage.retentionMs.",
        evidence: {
          footprintBytes: report.footprintBytes,
          maxBytes: input.maxBytes,
          considered: all.length,
          protectedByWindow,
          protectedLive,
        },
      })
      // The budget ratio is the series that shows how far past a reachable
      // target the store is, so an infeasible pass reports it too.
      recordPass(report, input.maxBytes)
      return report
    }

    const deadline = performance.now() + (input.budgetMs ?? DEFAULT_BUDGET_MS)
    for (const owner of candidates) {
      if (!overBudget() || performance.now() > deadline) break
      // Re-check liveness immediately before deleting: a session can start
      // between enumeration and this prune.
      if (owner.kind === "session" && new Set(input.liveSessionIDs).has(owner.id)) continue
      const removed = await handle.store.pruneTree(owner.key)
      report.pruned.push({ key: owner.key, records: removed })
      report.deletedRecords += removed
    }
    // Reclaim only when this pass returned bytes; an unconditional reclaim would
    // pay the checkpoint and vacuum cost on every tick including the ones that
    // pruned nothing.
    if (filename && report.pruned.length) {
      const reclaimed = await handle.store.maintain({ operation: "reclaim", maxPages: RECLAIM_PAGES })
      report.releasedPages = reclaimed.releasedPages
    }
    report.footprintBytes = footprint()
    report.capped = report.footprintBytes > input.maxBytes
    recordPass(report, input.maxBytes)
    return report
  }

  function recordPass(report: Report, maxBytes: number) {
    const labels = { infeasible: report.infeasible }
    ObservabilityMetrics.record({
      name: "storage.retention.pass",
      value: 1,
      unit: "count",
      module: "storage",
      labels,
    })
    ObservabilityMetrics.record({
      name: "storage.retention.deleted_records",
      value: report.deletedRecords,
      unit: "count",
      module: "storage",
      labels,
    })
    ObservabilityMetrics.record({
      name: "storage.retention.budget_ratio",
      value: maxBytes > 0 ? report.footprintBytes / maxBytes : 0,
      unit: "count",
      module: "storage",
    })
    if (report.capped)
      log.warn("retention pass ended over budget", {
        footprintBytes: report.footprintBytes,
        maxBytes,
        pruned: report.pruned.length,
        deletedRecords: report.deletedRecords,
      })
  }
}
