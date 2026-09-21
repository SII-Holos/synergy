import { Storage } from "./storage"
import { Log } from "../util/log"
import { SqliteMaintenance } from "./sqlite-maintenance"
import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityMetrics } from "../observability/metrics"
import type { TransactionalStore } from "./transactional-store"

const log = Log.create({ service: "storage.retention" })

/**
 * Budgeted retention for authoritative rollout evidence.
 *
 * Pruning is off unless a window is configured, and the byte budget is a
 * backstop rather than a target: nothing is enumerated, scanned or deleted
 * while the store is inside it. The operative window is derived from that budget
 * and the measured ingress rate, because a fixed window beside a byte budget can
 * promise more evidence than the budget holds: at the measured ingress of a busy
 * host a 7-day window needs about 63 GB, so a 40 GiB budget was unreachable,
 * every sweep found nothing it was allowed to remove, and the store kept
 * growing. `retentionMs` is therefore a promise ceiling, and the window is the
 * shorter of it and `retentionBytes / ingress`, never below one day. Only a
 * budget that cannot hold even that shortest window refuses to delete; it
 * reports the condition instead of repeating a pass that cannot converge.
 *
 * A pass removes whole evidence trees oldest-first and stops once the physical
 * database is back inside its budget. Two protections are absolute: a session
 * or operation whose newest record is inside the window is never touched, and a
 * live session is never touched even when its evidence is older than the
 * window. Rollout evidence carries rewind/restore/replay semantics, so a pruned
 * tree is gone for good; both protections are therefore evaluated before any
 * delete runs.
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
    /** The window the byte budget and the measured ingress rate allow: never
     *  longer than the configured window, never shorter than the floor, and the
     *  configured window until a rate has been measured. */
    effectiveWindowMs: number
    /** The configured window promises more evidence than the byte budget holds,
     *  so the operative window is shorter than the configured one. */
    windowReduced: boolean
    /** The smoothed ingress rate this pass derived its window from, absent until
     *  two over-budget passes have bracketed an interval. */
    ingressBytesPerMs?: number
    /** The byte budget cannot hold even the shortest permitted window, so no
     *  pass this policy allows can reach it. */
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

  // The shortest window a byte budget may shrink retention to: evidence an
  // operator still expects to rewind must not disappear because ingress
  // temporarily outran capacity. A budget that cannot hold even this much is
  // reported as unreachable instead of being pursued with shorter windows.
  export const WINDOW_FLOOR_MS = 24 * 60 * 60 * 1000
  // One interval can carry a migration, a bulk import or a vacuum, none of which
  // is steady-state ingress, so each measurement is halved against the estimate
  // it updates rather than becoming it.
  const INGRESS_SMOOTHING = 0.5
  // The `storage_meta` family the store keeps its own bookkeeping in (identity,
  // artifact migration, notification reconciliation), so a restart resumes from
  // the measured rate instead of re-learning it.
  export const INGRESS_KEY = ["storage_meta", "retention-ingress"]
  // The worker never sets `page_size`, so a page a pass released is SQLite's
  // documented 4096 bytes. Reading the real value would put a statement on the
  // sweep whose whole point is to decide its work from signals it already has.
  const SQLITE_PAGE_BYTES = 4096

  interface IngressSample {
    version: 1
    /** Physical footprint at the start of the pass that recorded it. */
    footprintBytes: number
    /** Pages that pass returned after that footprint was taken, so the next
     *  interval adds them back rather than reading its own reclaim as a fall. */
    releasedPages: number
    sampledAt: number
    ingressBytesPerMs?: number
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<Report> | undefined
  let consecutiveCapped = 0
  let cooldownUntil = 0

  export function isEnabled(retentionMs: number | undefined): retentionMs is number {
    return typeof retentionMs === "number" && Number.isFinite(retentionMs) && retentionMs > 0
  }

  /**
   * The window a byte budget supports at a measured ingress rate, and whether
   * that budget can be reached at all.
   *
   * The floor bounds how short a budget may make retention, and a budget whose
   * steady state at that floor still exceeds it is unreachable by any pass this
   * policy permits. That is decided before any enumeration, so an unreachable
   * budget costs one measurement instead of a scan it cannot act on.
   */
  export function deriveWindow(input: {
    retentionMs: number
    maxBytes: number
    ingressBytesPerMs: number | undefined
  }): { windowMs: number; floorMs: number; infeasible: boolean } {
    // The floor never exceeds the configured window: an operator who retains for
    // six hours has already asked for less than a day, and extending that would
    // retain evidence they chose to drop.
    const floorMs = Math.min(WINDOW_FLOOR_MS, input.retentionMs)
    const ingress = input.ingressBytesPerMs
    // Without a budget, or without a rate anybody has measured, there is nothing
    // to derive from, so the configured window stands and no pass refuses work
    // on the strength of a rate nobody measured.
    if (input.maxBytes <= 0 || ingress === undefined || !(ingress > 0))
      return { windowMs: input.retentionMs, floorMs, infeasible: false }
    const targetMs = input.maxBytes / ingress
    return {
      windowMs: Math.min(input.retentionMs, Math.max(floorMs, targetMs)),
      floorMs,
      infeasible: targetMs < floorMs,
    }
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
    stop()
    timer = setInterval(() => {
      if (running) return
      if (Date.now() < cooldownUntil) return
      const config = input.current()
      if (!isEnabled(config.retentionMs)) return
      running = run({ ...config, liveSessionIDs: input.liveSessionIDs() })
        .then((report) => {
          consecutiveCapped = report.capped ? consecutiveCapped + 1 : 0
          cooldownUntil = report.capped
            ? Date.now() + BACKOFF_BASE_MS * 2 ** Math.min(consecutiveCapped - 1, BACKOFF_MAX_STEPS)
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
          running = undefined
        }) as Promise<Report>
    }, SWEEP_INTERVAL_MS)
    timer.unref()
  }

  export function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
    consecutiveCapped = 0
    cooldownUntil = 0
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
    const sampledAt = input.now ?? Date.now()
    const startFootprintBytes = footprint()
    const empty: Report = {
      considered: 0,
      protectedByWindow: 0,
      protectedLive: 0,
      pruned: [],
      deletedRecords: 0,
      releasedPages: 0,
      footprintBytes: startFootprintBytes,
      capped: false,
      effectiveWindowMs: input.retentionMs ?? 0,
      windowReduced: false,
      ingressBytesPerMs: undefined,
      infeasible: false,
    }
    if (!isEnabled(input.retentionMs)) return empty
    // The budget gates the pass, so it is read before any enumeration: an
    // over-budget recovery is the only reason to pay for the owner scan.
    const overBudget = () => !filename || footprint() > input.maxBytes
    if (!overBudget()) return empty

    const previous = filename ? await readIngressSample(handle.store) : undefined
    const effective = deriveWindow({
      retentionMs: input.retentionMs,
      maxBytes: input.maxBytes,
      ingressBytesPerMs: previous?.ingressBytesPerMs,
    })
    const reduced = effective.windowMs < input.retentionMs
    // The window a pass applies comes from the estimate the previous pass
    // recorded, because it decides what may be deleted before this pass has
    // finished measuring. The report carries both: the window this pass applied,
    // and the estimate this pass now records.
    let settled: IngressSample | undefined
    const settle = async (releasedPages: number) => {
      if (!filename) return
      settled = advanceIngress(previous, { footprintBytes: startFootprintBytes, releasedPages, sampledAt })
      await handle.store.write(INGRESS_KEY, settled)
    }
    const estimate = () => settled?.ingressBytesPerMs ?? previous?.ingressBytesPerMs
    if (effective.infeasible) {
      // The budget holds less evidence than the shortest window this policy
      // permits, so removing the oldest evidence it permits could not reach it.
      // The pass re-measures the rate that decided the condition and stops:
      // enumerating and deleting would cost the same and buy no capacity.
      await settle(0)
      const report: Report = {
        ...empty,
        effectiveWindowMs: effective.windowMs,
        windowReduced: reduced,
        ingressBytesPerMs: estimate(),
        infeasible: true,
        capped: true,
      }
      ObservabilityIssues.raise({
        code: "STORAGE_RETENTION_BUDGET_INFEASIBLE",
        severity: "warning",
        module: "storage",
        title: "Retention budget cannot be reached",
        message:
          "Authoritative storage is over its byte budget and that budget holds less evidence than the shortest permitted retention window, so no pass this policy allows can reach it.",
        recommendation:
          "Raise storage.retentionBytes above one day of the measured ingress rate, or reduce what the store ingests.",
        evidence: {
          footprintBytes: report.footprintBytes,
          maxBytes: input.maxBytes,
          ingressBytesPerMs: estimate(),
          floorMs: effective.floorMs,
          effectiveWindowMs: effective.windowMs,
        },
      })
      recordPass(report, input.maxBytes)
      return report
    }
    if (reduced) {
      // Retaining less than the configured window is a real degradation rather
      // than a defect to repair, so it is reported where an operator already
      // looks for storage problems. Raising on every pass is what the issue
      // store is built for: one open issue per fingerprint accumulates
      // occurrences instead of adding a row, so a steady state stays one entry.
      ObservabilityIssues.raise({
        code: "STORAGE_RETENTION_WINDOW_REDUCED",
        severity: "warning",
        module: "storage",
        title: "Retention window shortened to fit the byte budget",
        message:
          "Measured ingress fills the authoritative byte budget faster than the configured retention window promises, so pruning retains the budget-derived window rather than the configured one.",
        recommendation:
          "Raise storage.retentionBytes, or set storage.retentionMs to the window the budget actually holds so the configured promise and the retained evidence agree.",
        evidence: {
          retentionMs: input.retentionMs,
          effectiveWindowMs: effective.windowMs,
          ingressBytesPerMs: estimate(),
          maxBytes: input.maxBytes,
          footprintBytes: startFootprintBytes,
        },
      })
    }

    const all = await owners()
    const { candidates, protectedByWindow, protectedLive } = protectedOwners({
      owners: all,
      retentionMs: effective.windowMs,
      liveSessionIDs: input.liveSessionIDs,
      now: input.now,
    })
    const report: Report = {
      ...empty,
      considered: all.length,
      protectedByWindow,
      protectedLive,
      effectiveWindowMs: effective.windowMs,
      windowReduced: reduced,
      ingressBytesPerMs: previous?.ingressBytesPerMs,
    }
    // A pass that ends still over budget leaves the store's own growth in place,
    // and the next sample raises the estimate that shortens the window until the
    // evidence protecting this budget is outside it. That is what the
    // scheduler's capped backoff bounds, so this pass neither loops here nor
    // reports a condition the next sweep resolves.
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
    await settle(report.releasedPages)
    report.ingressBytesPerMs = estimate()
    recordPass(report, input.maxBytes)
    return report
  }

  /**
   * Reads the durable ingress estimate. A sample that is absent, from another
   * format version, or not finite is treated as no measurement rather than
   * derived from: the window it would set governs which evidence may be removed
   * permanently.
   */
  async function readIngressSample(store: TransactionalStore): Promise<IngressSample | undefined> {
    const [stored] = await store.readMany<IngressSample>([INGRESS_KEY])
    if (!stored || stored.version !== 1) return undefined
    if (!Number.isFinite(stored.footprintBytes) || !Number.isFinite(stored.sampledAt)) return undefined
    if (stored.ingressBytesPerMs !== undefined && !Number.isFinite(stored.ingressBytesPerMs)) return undefined
    return stored
  }

  /**
   * Advances the durable ingress estimate by one pass.
   *
   * Both halves of the measurement are signals a pass already has: the store's
   * physical footprint, a `statSync` of the database and its sidecars rather
   * than a scan, and the pages the previous pass released. Those pages are added
   * back because the sample that recorded them was taken before the reclaim they
   * came from: without that, a pass that returned bytes would read as a fall in
   * ingress and lengthen the window it just paid to shorten.
   */
  function advanceIngress(
    previous: IngressSample | undefined,
    current: { footprintBytes: number; releasedPages: number; sampledAt: number },
  ): IngressSample {
    const next: IngressSample = {
      version: 1,
      footprintBytes: current.footprintBytes,
      releasedPages: current.releasedPages,
      sampledAt: current.sampledAt,
      ingressBytesPerMs: previous?.ingressBytesPerMs,
    }
    if (!previous) return next
    const elapsedMs = current.sampledAt - previous.sampledAt
    if (elapsedMs <= 0) return next
    const measured =
      (current.footprintBytes - previous.footprintBytes + previous.releasedPages * SQLITE_PAGE_BYTES) / elapsedMs
    if (!Number.isFinite(measured)) return next
    const smoothed =
      previous.ingressBytesPerMs === undefined
        ? measured
        : INGRESS_SMOOTHING * measured + (1 - INGRESS_SMOOTHING) * previous.ingressBytesPerMs
    // A store that shrank reports no ingress, which leaves the configured window
    // in force instead of deriving one from a negative rate.
    return { ...next, ingressBytesPerMs: Math.max(0, smoothed) }
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
        effectiveWindowMs: report.effectiveWindowMs,
        windowReduced: report.windowReduced,
        ingressBytesPerMs: report.ingressBytesPerMs,
      })
  }
}
