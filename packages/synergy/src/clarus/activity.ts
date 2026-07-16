import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import type { ClarusProjectActivity } from "./schemas"
import { ClarusProjectActivitySchema } from "./schemas"

const ACTIVITY_TS_PAD = 16
const ACTIVITY_SORT_SEP = "--"

function buildActivitySortKey(receivedAt: number, messageId: string): string {
  return `${String(receivedAt).padStart(ACTIVITY_TS_PAD, "0")}${ACTIVITY_SORT_SEP}${encodeURIComponent(messageId)}`
}

function parseActivitySortKey(sortKey: string): { receivedAt: number; messageId: string } | null {
  const sepIdx = sortKey.indexOf(ACTIVITY_SORT_SEP)
  if (sepIdx === -1) return null
  const ts = parseInt(sortKey.slice(0, sepIdx), 10)
  if (isNaN(ts)) return null
  return { receivedAt: ts, messageId: decodeURIComponent(sortKey.slice(sepIdx + ACTIVITY_SORT_SEP.length)) }
}

/** Advisory lock key for serializing concurrent upserts on one messageId. */
function upsertLockKey(agentId: string, projectId: string, messageId: string): string {
  return `clarus:upsert:${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(messageId)}`
}

export namespace ClarusProjectActivityStore {
  export async function upsert(activity: ClarusProjectActivity): Promise<ClarusProjectActivity> {
    const validated = ClarusProjectActivitySchema.parse(activity)
    const lockKey = upsertLockKey(validated.agentId, validated.projectId, validated.messageId)
    using _ = await Lock.write(lockKey)
    // 1. Persist canonical record first (idempotent by messageId).
    await Storage.write(
      StoragePath.clarusProjectActivity(validated.agentId, validated.projectId, validated.messageId),
      validated,
    )
    // 2. Clean up any stale timeline entries for this messageId (handles receivedAt change).
    const timelinePrefix = StoragePath.clarusActivityTimelineIndex(validated.agentId, validated.projectId)
    const existingKeys = await Storage.scan(timelinePrefix)
    let cleaned = 0
    for (const key of existingKeys) {
      const parsed = parseActivitySortKey(key)
      if (parsed?.messageId === validated.messageId) {
        await Storage.remove([...timelinePrefix, key])
        cleaned++
      }
    }
    // 3. Write new timeline index entry.
    const sortKey = buildActivitySortKey(validated.receivedAt, validated.messageId)
    await Storage.write([...timelinePrefix, sortKey], { messageId: validated.messageId })
    // If we had stale entries, the clean count is for instrumentation.
    void cleaned
    return validated
  }

  export async function get(
    agentId: string,
    projectId: string,
    messageId: string,
  ): Promise<ClarusProjectActivity | undefined> {
    const raw = await Storage.read<unknown>(StoragePath.clarusProjectActivity(agentId, projectId, messageId)).catch(
      () => undefined,
    )
    if (!raw) return undefined
    const parsed = ClarusProjectActivitySchema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  export async function listByProject(agentId: string, projectId: string): Promise<ClarusProjectActivity[]> {
    const prefix = [
      ...StoragePath.clarusProjectActivityRoot(),
      encodeURIComponent(agentId),
      encodeURIComponent(projectId),
    ]
    const keys = await Storage.scan(prefix)
    if (keys.length === 0) return []

    const storageKeys = keys.map((key) => [...prefix, key])
    const results = await Storage.readMany<unknown>(storageKeys)
    const activities: ClarusProjectActivity[] = []
    for (const result of results) {
      if (!result) continue
      const parsed = ClarusProjectActivitySchema.safeParse(result)
      if (parsed.success) activities.push(parsed.data)
    }
    activities.sort((a, b) => a.receivedAt - b.receivedAt)
    return activities
  }

  const ACTIVITY_PAGE_LIMIT_MAX = 100
  /** Per-page scan window is limit × 2 to tolerate corrupt/ghost entries. */
  const SCAN_MULTIPLIER = 2
  /** Maximum ghost index entries cleaned per page scan (defensive). */
  const GHOST_CLEAN_BUDGET = 10
  /** Maximum orphaned canonicals repaired per call. */
  const REPAIR_BUDGET = 5

  export interface PaginatedResult {
    items: ClarusProjectActivity[]
    nextCursor: string | null
  }

  // Per-project bounded repair cursors.
  // Key: `${encodeURIComponent(agentId)}::${encodeURIComponent(projectId)}`
  // Value: last scanned canonical messageId (the repair resume point).
  const repairCursors = new Map<string, string | null>()

  /**
   * Bounded repair: finds canonicals without index entries and creates them.
   * Scans at most REPAIR_BUDGET canonicals per call, advancing a per-project
   * cursor so subsequent calls pick up where the last left off.
   */
  async function repairOrphanedCanonicals(
    agentId: string,
    projectId: string,
    existingIndexedIds: Set<string>,
  ): Promise<number> {
    const canonPrefix = [
      ...StoragePath.clarusProjectActivityRoot(),
      encodeURIComponent(agentId),
      encodeURIComponent(projectId),
    ]
    const canonKeys = await Storage.scan(canonPrefix)
    if (canonKeys.length === 0) return 0

    const repairKey = `${encodeURIComponent(agentId)}::${encodeURIComponent(projectId)}`
    const cursor = repairCursors.get(repairKey)
    let resumeIdx = 0
    if (cursor !== undefined && cursor !== null) {
      const idx = canonKeys.indexOf(cursor)
      if (idx >= 0) resumeIdx = idx + 1
    }

    let repaired = 0
    let lastScanned: string | null = null
    const timelinePrefix = StoragePath.clarusActivityTimelineIndex(agentId, projectId)
    const scanEnd = Math.min(resumeIdx + REPAIR_BUDGET * 2, canonKeys.length)

    for (let i = resumeIdx; i < scanEnd && repaired < REPAIR_BUDGET; i++) {
      lastScanned = canonKeys[i]
      if (existingIndexedIds.has(canonKeys[i])) continue

      const canonical = await get(agentId, projectId, canonKeys[i])
      if (!canonical) continue

      const sortKey = buildActivitySortKey(canonical.receivedAt, canonical.messageId)
      await Storage.write([...timelinePrefix, sortKey], { messageId: canonical.messageId })
      existingIndexedIds.add(canonical.messageId)
      repaired++
    }

    if (lastScanned !== null) {
      repairCursors.set(repairKey, lastScanned)
    } else if (resumeIdx >= canonKeys.length) {
      // Fully exhausted: reset cursor so future canonical additions are picked up.
      repairCursors.delete(repairKey)
    }

    return repaired
  }

  /**
   * List project activity in global ascending chronological order across pages
   * via the agent/project timeline index. The index is a directory of sortable
   * keys ({padded receivedAt}--{encoded messageId}) that reference canonical
   * activity records by messageId.
   *
   * Cursor semantics:
   * - The cursor is the last sortKey scanned (valid or corrupt), so progress
   *   continues even through corrupt index windows.
   * - Next page resumes strictly after the cursor in scan order.
   * - Forward-only: insertions after the cursor appear on subsequent pages;
   *   earlier backfills are not visible to a cursor that has already passed
   *   them. Each page is a snapshot at the moment of its scan.
   * - Default limit 20, max 100.
   * - Unknown/malformed cursors resume from the beginning (deterministic).
   */
  export async function listByProjectPaginated(
    agentId: string,
    projectId: string,
    options: { limit: number; cursor?: string },
  ): Promise<PaginatedResult> {
    const effectiveLimit = Math.min(Math.max(options.limit, 1), ACTIVITY_PAGE_LIMIT_MAX)
    const timelinePrefix = StoragePath.clarusActivityTimelineIndex(agentId, projectId)
    const sortKeys = await Storage.scan(timelinePrefix)

    if (sortKeys.length === 0) {
      // Even with no index, run bounded repair in case crash orphans exist.
      await repairOrphanedCanonicals(agentId, projectId, new Set())
      return { items: [], nextCursor: null }
    }

    // Build set of known indexed messageIds for repair.
    const indexedIds = new Set<string>()
    for (const key of sortKeys) {
      const parsed = parseActivitySortKey(key)
      if (parsed) indexedIds.add(parsed.messageId)
    }

    // Bounded repair for canonicals without index (crash recovery).
    await repairOrphanedCanonicals(agentId, projectId, indexedIds)

    // Re-scan: repair may have added new index entries which could sort before
    // or after our cursor. Accept a snapshot read of current state.
    const currentKeys = await Storage.scan(timelinePrefix)

    // Find resume position from cursor (forward-only, skip cursor key itself).
    let resumeIdx = 0
    if (options.cursor) {
      const cursorIdx = currentKeys.indexOf(options.cursor)
      if (cursorIdx >= 0) resumeIdx = cursorIdx + 1
    }

    const activities: ClarusProjectActivity[] = []
    const seenMessageIds = new Set<string>()
    let lastScannedKey: string | null = null
    let ghostCleaned = 0
    const scanEnd = Math.min(resumeIdx + effectiveLimit * SCAN_MULTIPLIER, currentKeys.length)

    for (let i = resumeIdx; i < scanEnd && activities.length < effectiveLimit; i++) {
      const sortKey = currentKeys[i]
      lastScannedKey = sortKey

      const parsed = parseActivitySortKey(sortKey)
      if (!parsed) {
        // Unparseable sort key: ghost removal within budget.
        if (ghostCleaned < GHOST_CLEAN_BUDGET) {
          await Storage.remove([...timelinePrefix, sortKey]).catch(() => {})
          ghostCleaned++
        }
        continue
      }

      const canonical = await get(agentId, projectId, parsed.messageId)
      if (!canonical) {
        // Index entry without canonical: ghost removal within budget.
        if (ghostCleaned < GHOST_CLEAN_BUDGET) {
          await Storage.remove([...timelinePrefix, sortKey]).catch(() => {})
          ghostCleaned++
        }
        continue
      }

      // Defensive deduplication within page.
      if (seenMessageIds.has(canonical.messageId)) continue
      seenMessageIds.add(canonical.messageId)
      activities.push(canonical)
    }

    // Cursor: lastScannedKey is the final sort key we examined (valid or not).
    // Advance if any keys remain after it.
    const hasMoreKeys =
      lastScannedKey !== null &&
      (() => {
        const lastIdx = currentKeys.indexOf(lastScannedKey)
        return lastIdx >= 0 && lastIdx + 1 < currentKeys.length
      })()
    const nextCursor = hasMoreKeys ? lastScannedKey : null

    return { items: activities, nextCursor }
  }
}

/** Per-target fanout progress tracking for deterministic project context
 *  delivery. Each entry records that a specific target session has received
 *  a specific project message, enabling crash-idempotent partial-failure
 *  retry — only missing targets are re-delivered. */
export namespace ClarusFanoutProgressStore {
  function fanoutProgressKey(agentId: string, projectId: string, messageId: string, sessionID: string): string[] {
    return [
      "clarus",
      "fanout",
      encodeURIComponent(agentId),
      encodeURIComponent(projectId),
      encodeURIComponent(messageId),
      encodeURIComponent(sessionID),
    ]
  }

  /** Check whether the target session has already received this project message. */
  export async function isDelivered(
    agentId: string,
    projectId: string,
    messageId: string,
    sessionID: string,
  ): Promise<boolean> {
    const raw = await Storage.read<unknown>(fanoutProgressKey(agentId, projectId, messageId, sessionID)).catch(
      () => undefined,
    )
    return raw !== undefined
  }

  /** Record durable delivery for a specific target. */
  export async function recordDelivery(
    agentId: string,
    projectId: string,
    messageId: string,
    sessionID: string,
  ): Promise<void> {
    await Storage.write(fanoutProgressKey(agentId, projectId, messageId, sessionID), { deliveredAt: Date.now() })
  }

  /** Delete all per-target progress entries for a project message.
   *  Called after project dedup is durably recorded with outcome "injected"
   *  to bound fanout storage growth. Deterministic inbox item IDs remain the
   *  durable replay/collision guard after cleanup. */
  export async function deleteAllDeliveriesByMessage(
    agentId: string,
    projectId: string,
    messageId: string,
  ): Promise<void> {
    const prefix = [
      "clarus",
      "fanout",
      encodeURIComponent(agentId),
      encodeURIComponent(projectId),
      encodeURIComponent(messageId),
    ]
    const keys = await Storage.scan(prefix)
    await Promise.all(keys.map((key) => Storage.remove([...prefix, key])))
  }
}
