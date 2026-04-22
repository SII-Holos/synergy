import z from "zod"
import { Session } from "@/session"
import type { Info as SessionInfo } from "@/session/types"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "@/id/id"
import { Aggregator } from "./aggregator"
import { StatsStorage } from "./storage"
import { Rollup } from "./rollup"
import type {
  SessionDigest,
  StatsWatermark,
  StatsSnapshot,
  DailyBucket,
  TokenBreakdown,
  ProgressCallback,
} from "./types"

export namespace Engine {
  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run incremental stats update: scan sessions changed since watermark,
   * update digests + daily buckets, recompute snapshot.
   */
  export async function update(onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    const watermark = await StatsStorage.getWatermark()

    onProgress?.({ phase: "scan", current: 0, total: 1, message: "Scanning sessions..." })
    const allSessions = await getAllSessions()

    let newOrUpdated: SessionInfo[]
    let deletedIDs: string[]

    if (watermark) {
      const knownSet = new Set(watermark.sessionIDs)
      const currentMap = new Map(allSessions.map((s) => [s.id, s]))

      // Sessions that are new or updated since watermark
      newOrUpdated = allSessions.filter((s) => !knownSet.has(s.id) || s.time.updated > watermark.lastUpdated)

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

    // Update daily buckets incrementally
    onProgress?.({ phase: "bucket", current: 0, total: 1, message: "Updating daily buckets..." })
    await updateDailyBuckets(freshDigests, deletedIDs)

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
    await StatsStorage.setWatermark(newWatermark)

    // Compute and store snapshot
    const snapshot = Rollup.snapshot(allDigests, maxUpdated)
    await StatsStorage.setSnapshot(snapshot)

    onProgress?.({ phase: "snapshot", current: 1, total: 1, message: "Done" })
    return snapshot
  }

  /**
   * Get current stats snapshot (returns cached if available, otherwise computes).
   */
  export async function get(onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    const existing = await StatsStorage.getSnapshot()
    if (existing) return existing
    return update(onProgress)
  }

  /**
   * Force full recompute from scratch (clears all cached stats).
   */
  export async function recompute(onProgress?: ProgressCallback): Promise<StatsSnapshot> {
    await StatsStorage.setWatermark({
      lastUpdated: 0,
      sessionIDs: [],
      lastFullScanAt: 0,
    })
    return update(onProgress)
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

  async function updateDailyBuckets(freshDigests: SessionDigest[], deletedIDs: string[]): Promise<void> {
    // Load old digests for sessions being updated (to subtract their contribution)
    const oldDigests: SessionDigest[] = []
    for (const d of freshDigests) {
      const old = await StatsStorage.getDigest(d.sessionID)
      if (old) oldDigests.push(old)
    }

    // Also load old digests for deleted sessions
    for (const id of deletedIDs) {
      const old = await StatsStorage.getDigest(id)
      if (old) oldDigests.push(old)
    }

    // Collect all affected days
    const affectedDays = new Set<string>()

    // Subtract old contributions
    for (const old of oldDigests) {
      const day = dayKey(old.created)
      affectedDays.add(day)
      const existing = await StatsStorage.getDailyBucket(day)
      if (existing) {
        const subtracted = subtractFromBucket(existing, old)
        await StatsStorage.setDailyBucket(day, subtracted)
      }
    }

    // Add new contributions
    for (const fresh of freshDigests) {
      const day = dayKey(fresh.created)
      affectedDays.add(day)
      const existing = await StatsStorage.getDailyBucket(day)
      const incoming = Rollup.sessionToDailyBucket(fresh)
      const merged = Rollup.mergeDailyBucket(existing, incoming)
      await StatsStorage.setDailyBucket(day, merged)
    }

    // Clean up empty buckets (zero sessions after subtraction)
    for (const day of affectedDays) {
      const bucket = await StatsStorage.getDailyBucket(day)
      if (bucket && bucket.sessions <= 0 && bucket.turns <= 0) {
        await Storage.remove(StoragePath.statsDaily(day))
      }
    }
  }

  function subtractFromBucket(bucket: DailyBucket, digest: SessionDigest): DailyBucket {
    const sub = Rollup.sessionToDailyBucket(digest)
    return {
      day: bucket.day,
      sessions: bucket.sessions - sub.sessions,
      turns: bucket.turns - sub.turns,
      tokens: subtractTokens(bucket.tokens, sub.tokens),
      cost: bucket.cost - sub.cost,
      additions: bucket.additions - sub.additions,
      deletions: bucket.deletions - sub.deletions,
      files: bucket.files - sub.files,
      toolCalls: bucket.toolCalls - sub.toolCalls,
      errors: bucket.errors - sub.errors,
    }
  }

  function subtractTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
    return {
      input: a.input - b.input,
      output: a.output - b.output,
      reasoning: a.reasoning - b.reasoning,
      cache: {
        read: a.cache.read - b.cache.read,
        write: a.cache.write - b.cache.write,
      },
    }
  }

  function dayKey(timestamp: number): string {
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }
}
