import { Storage } from "./storage"
import { Log } from "../util/log"
import { SqliteMaintenance } from "./sqlite-maintenance"

const log = Log.create({ service: "storage.retention" })

/**
 * Budgeted retention for authoritative rollout evidence.
 *
 * Pruning is off unless a window is configured, removes whole evidence trees
 * oldest-first, and stops once the physical database is back inside its byte
 * budget. Two protections are absolute: a session or operation whose newest
 * record is inside the window is never touched, and a live session is never
 * touched even when its evidence is older than the window. Rollout evidence
 * carries rewind/restore/replay semantics, so a pruned tree is gone for good;
 * both protections are therefore evaluated before any delete runs.
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
  }

  const SWEEP_INTERVAL_MS = 15 * 60_000
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<Report> | undefined

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
    stop()
    timer = setInterval(() => {
      if (running) return
      const config = input.current()
      if (!isEnabled(config.retentionMs)) return
      running = run({ ...config, liveSessionIDs: input.liveSessionIDs() })
        .catch((error) => {
          log.warn("retention pass failed", { error })
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
   * regardless of how much evidence an owner holds.
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
    const empty: Report = {
      considered: 0,
      protectedByWindow: 0,
      protectedLive: 0,
      pruned: [],
      deletedRecords: 0,
      releasedPages: 0,
      footprintBytes: filename ? SqliteMaintenance.physicalFootprint(filename) : 0,
      capped: false,
    }
    if (!isEnabled(input.retentionMs)) return empty

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
    }
    const overBudget = () => !filename || SqliteMaintenance.physicalFootprint(filename) > input.maxBytes
    if (!overBudget()) return report

    const deadline = performance.now() + (input.budgetMs ?? 500)
    for (const owner of candidates) {
      if (!overBudget() || performance.now() > deadline) break
      // Re-check liveness immediately before deleting: a session can start
      // between enumeration and this prune.
      if (owner.kind === "session" && new Set(input.liveSessionIDs).has(owner.id)) continue
      const removed = await handle.store.pruneTree(owner.key)
      report.pruned.push({ key: owner.key, records: removed })
      report.deletedRecords += removed
    }
    if (filename) {
      const reclaimed = await handle.store.maintain({ operation: "reclaim", maxPages: 8192 })
      report.releasedPages = reclaimed.releasedPages
      report.footprintBytes = SqliteMaintenance.physicalFootprint(filename)
      report.capped = report.footprintBytes > input.maxBytes
    }
    return report
  }
}
