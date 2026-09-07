import { RolloutSnapshot } from "@/session/rollout/snapshot"
import { OperationDigest } from "./types"
import z from "zod"
import { Lock } from "@/util/lock"
import { RolloutJournal } from "@/session/rollout/journal"
import type { Info as SessionInfo } from "@/session/types"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "@/id/id"
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
    return refresh(false, onProgress)
  }

  async function operationDigests() {
    const result: OperationDigest[] = []
    const retained = new Set<string>()
    for (const scopeID of await Storage.scan(["operations"], { strict: true })) {
      for (const operationID of await Storage.scan(["operations", scopeID], { strict: true })) {
        const owner = { kind: "operation" as const, scopeID, operationID }
        const revision = (await RolloutJournal.head(owner)).committed
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
    for (const scopeID of await Storage.scan(StoragePath.statsOperations(), { strict: true }))
      for (const id of await Storage.scan([...StoragePath.statsOperations(), scopeID], { strict: true })) {
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
              RolloutJournal.head({ kind: "session", scopeID: session.scope.id, sessionID: session.id }),
            ])
            return digest?.rolloutRevision !== revision.committed
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

  /**
   * Refresh changed session and rollout digests before returning the snapshot.
   */
  export async function get(onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    return update(onProgress)
  }

  /**
   * Force full recompute from scratch (clears all cached stats).
   */
  export async function recompute(onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    return refresh(true, onProgress)
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function getAllSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = []
    const scopeIDs = await Storage.scan(StoragePath.scopeRoot())
    const scopes = await Storage.readMany<z.infer<typeof Scope.Info>>(
      scopeIDs.map((id) => StoragePath.scope(Identifier.asScopeID(id))),
    )
    const homeScopeID = Identifier.asScopeID("home")
    const homeSessionIDs = await Storage.scan(StoragePath.sessionsRoot(homeScopeID))
    const homeSessions = await Storage.readMany<SessionInfo>(
      homeSessionIDs.map((sid) => StoragePath.sessionInfo(homeScopeID, Identifier.asSessionID(sid))),
    )
    for (const info of homeSessions) {
      if (info) sessions.push(info)
    }

    for (const scope of scopes) {
      if (!scope) continue
      const scopeID = Identifier.asScopeID(scope.id)
      const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scopeID))
      const sessionInfos = await Storage.readMany<SessionInfo>(
        sessionIDs.map((sid) => StoragePath.sessionInfo(scopeID, Identifier.asSessionID(sid))),
      )
      for (const info of sessionInfos) {
        if (info) sessions.push(info)
      }
    }

    return sessions
  }
}
