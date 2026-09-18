import { RolloutSnapshot } from "@ericsanchezok/synergy-harness/session/rollout/snapshot"
import { OperationDigest } from "./types"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { readRolloutRevision } from "@ericsanchezok/synergy-harness/rollout"
import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Aggregator } from "./aggregator"
import { StatsStorage } from "./storage"
import { Rollup } from "./rollup"
import type { StatsWatermark, StatsSnapshot, ProgressCallback } from "./types"

export namespace Engine {
  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run incremental stats update: scan sessions changed since watermark,
   * update digests + daily buckets, recompute snapshot.
   */
  export async function update(onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    return requestRefresh(false, onProgress)
  }

  const jobs = Storage.state(
    () =>
      new Map<
        boolean,
        {
          promise: Promise<StatsSnapshot>
          listeners: Set<ProgressCallback>
        }
      >(),
  )

  function requestRefresh(full: boolean, onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    const running = jobs()
    const existing = running.get(full) ?? (!full ? running.get(true) : undefined)
    if (existing) {
      if (onProgress) existing.listeners.add(onProgress)
      return existing.promise.finally(() => {
        if (onProgress) existing.listeners.delete(onProgress)
      })
    }
    const listeners = new Set<ProgressCallback>(onProgress ? [onProgress] : [])
    const promise = refresh(full, (event) => {
      for (const listener of listeners)
        void Promise.resolve()
          .then(() => listener(event))
          .catch(() => listeners.delete(listener))
    }).finally(() => running.delete(full))
    running.set(full, { promise, listeners })
    return promise
  }

  async function operationDigests() {
    const result: OperationDigest[] = []
    const retained = new Set<string>()
    for (const scopeID of await Storage.scan(["operations"])) {
      for (const operationID of await Storage.scan(["operations", scopeID])) {
        const owner = { kind: "operation" as const, scopeID, operationID }
        const revision = await readRolloutRevision(owner)
        if (!revision) continue
        const key = StoragePath.statsOperation(scopeID, operationID)
        retained.add(key.join("/"))
        const cached = await Storage.read(key).catch((error) => {
          if (error instanceof Storage.NotFoundError) return undefined
          throw error
        })
        const parsed = OperationDigest.safeParse(cached)
        if (parsed.success && parsed.data.rolloutRevision === revision) {
          result.push(parsed.data)
          continue
        }
        const digest = Aggregator.operation(await RolloutSnapshot.read(owner, { revision }))
        await Storage.write(key, digest)
        result.push(digest)
      }
    }
    for (const scopeID of await Storage.scan(StoragePath.statsOperations()))
      for (const id of await Storage.scan([...StoragePath.statsOperations(), scopeID])) {
        const key = StoragePath.statsOperation(scopeID, id)
        if (!retained.has(key.join("/"))) await Storage.remove(key)
      }
    return result
  }

  async function refresh(full: boolean, onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    using lock = await Lock.write("stats-update")
    const watermark = full ? undefined : await StatsStorage.getWatermark()

    onProgress?.({ phase: "scan", current: 0, total: 1, message: "Scanning sessions..." })
    const allSessions = await getAllSessions()

    let newOrUpdated: SessionInfo[]
    let deletedIDs: string[]

    if (watermark) {
      const knownSet = new Set(watermark.sessionIDs)
      const currentMap = new Map(allSessions.map((s) => [s.id, s]))

      // Sessions that are new or updated since watermark
      newOrUpdated = []
      for (let offset = 0; offset < allSessions.length; offset += 20) {
        const batch = allSessions.slice(offset, offset + 20)
        const changed = await Promise.all(
          batch.map(async (session) => {
            if (!knownSet.has(session.id) || session.time.updated > watermark.lastUpdated) return true
            const [digest, revision] = await Promise.all([
              StatsStorage.getDigest(session.id),
              readRolloutRevision({ kind: "session", scopeID: session.scope.id, sessionID: session.id }),
            ])
            return digest?.rolloutRevision !== revision
          }),
        )
        newOrUpdated.push(...batch.filter((_, index) => changed[index]))
      }

      // Sessions that were known but no longer exist
      deletedIDs = watermark.sessionIDs.filter((id) => !currentMap.has(id))
    } else {
      newOrUpdated = allSessions
      deletedIDs = []
    }

    // Digest new/updated sessions with progress
    const freshDigests = await Aggregator.digestAll(newOrUpdated, (current, total) => {
      onProgress?.({ phase: "digest", current, total, message: `Digesting sessions ${current}/${total}...` })
    })

    // Write new/updated digests
    for (const d of freshDigests) {
      await StatsStorage.setDigest(d)
    }

    // Remove digests for deleted sessions
    for (const id of deletedIDs) {
      await StatsStorage.removeDigest(id)
    }

    // Load all digests for full snapshot
    onProgress?.({ phase: "snapshot", current: 0, total: 1, message: "Computing snapshot..." })
    const allDigests = await StatsStorage.getAllDigests()

    // Compute new watermark
    const maxUpdated = allSessions.length > 0 ? Math.max(...allSessions.map((s) => s.time.updated)) : 0
    const newWatermark: StatsWatermark = {
      lastUpdated: maxUpdated,
      sessionIDs: allSessions.map((s) => s.id),
      lastFullScanAt: Date.now(),
    }

    // Compute and store snapshot
    const snapshot = Rollup.snapshot(allDigests, maxUpdated, await operationDigests())
    onProgress?.({
      phase: "bucket",
      current: 0,
      total: snapshot.timeSeries.days.length,
      message: "Updating daily buckets...",
    })
    const days = new Set(snapshot.timeSeries.days.map((day) => day.day))
    for (const day of snapshot.timeSeries.days) await StatsStorage.setDailyBucket(day.day, day)
    for (const day of await StatsStorage.listDailyKeys()) {
      if (!days.has(day)) await Storage.remove(StoragePath.statsDaily(day))
    }
    await StatsStorage.setSnapshot(snapshot)
    await StatsStorage.setWatermark(newWatermark)

    onProgress?.({ phase: "snapshot", current: 1, total: 1, message: "Done" })
    return snapshot
  }

  export async function get(): Promise<StatsSnapshot | null> {
    return (await StatsStorage.getSnapshot()) ?? null
  }

  /**
   * Force full recompute from scratch (clears all cached stats).
   */
  export async function recompute(onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    return requestRefresh(true, onProgress)
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function getAllSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = []
    for await (const record of Storage.records<SessionInfo>({ kind: "session" })) sessions.push(record.value)
    return sessions
  }
}
