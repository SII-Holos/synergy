// Scope-independent session runtime state.
//
// Session status and the pending permission/question decisions are read by
// surfaces that render many sessions at once — sidebar rows, the Kanban board,
// the mobile drawer, the status bar — across every Scope. Keeping them in a
// per-Scope store meant a Scope eviction wiped the running state of sessions
// the user could still see, because the last retention lease is released as
// soon as the user switches project. These indexes are keyed by session id
// alone (session ids are globally unique) and live in the global store, which
// no eviction path touches.
//
// The snapshot merge follows the same post-stamp discipline as the Scope
// buckets: a snapshot response is stamped before its fields are read, so only
// keys with an event write after that stamp may override it. The key space is
// flat rather than (Scope, session) because none of this state is
// Scope-scoped.

import type { SessionStatus } from "@ericsanchezok/synergy-sdk"
import type { EventWriteStamp } from "./scope-snapshot-merge"

export type SessionStatusIndex = Record<string, SessionStatus>

export type ScopeStatusSnapshotAdoption = {
  /** Keys the snapshot contributes to the index. */
  adopt: SessionStatusIndex
  /** Owned sessions the snapshot omits, whose stale entries must be deleted. */
  drop: string[]
}

export function groupBySession<T extends { sessionID: string }>(items: readonly T[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {}
  for (const item of items) {
    const existing = grouped[item.sessionID]
    if (existing) existing.push(item)
    else grouped[item.sessionID] = [item]
  }
  return grouped
}

export function flattenBuckets<T>(buckets: Record<string, T[] | undefined>): T[] {
  const flat: T[] = []
  for (const bucket of Object.values(buckets)) {
    if (bucket) flat.push(...bucket)
  }
  return flat
}

/**
 * Post-stamp event-write tracking for the global session indexes.
 *
 * A status write records the sequencing stamp of the event that produced it, so
 * a snapshot whose stamp predates that event cannot resurrect the older value it
 * was read from. Pending permission and question requests are tracked per
 * request id for the same reason: a snapshot read before a reply arrived must
 * not restore a decision the user already answered.
 */
export class GlobalRuntimeWriteTracker {
  private epoch: string | undefined
  private readonly status = new Map<string, number>()
  private readonly permission = new Map<string, number>()
  private readonly question = new Map<string, number>()
  private readonly cortex = new Map<string, number>()
  private cortexReplaceSeq: number | undefined

  statusWrite(stamp: EventWriteStamp, sessionID: string) {
    this.syncEpoch(stamp)
    this.status.set(sessionID, stamp.seq)
  }

  permissionWrite(stamp: EventWriteStamp, requestID: string) {
    this.syncEpoch(stamp)
    this.permission.set(requestID, stamp.seq)
  }

  questionWrite(stamp: EventWriteStamp, requestID: string) {
    this.syncEpoch(stamp)
    this.question.set(requestID, stamp.seq)
  }

  cortexWrite(stamp: EventWriteStamp, taskID: string) {
    this.syncEpoch(stamp)
    this.cortex.set(taskID, stamp.seq)
  }

  cortexReplace(stamp: EventWriteStamp) {
    this.syncEpoch(stamp)
    this.cortex.clear()
    this.cortexReplaceSeq = stamp.seq
  }

  /**
   * Snapshot overlaid with status keys whose last event write postdates the
   * snapshot stamp. `undefined` means the snapshot is authoritative for every
   * key — including the idle sessions it omits, whose local entries the caller's
   * reconcile then drops.
   */
  mergeStatus(
    version: EventWriteStamp | undefined,
    snapshot: SessionStatusIndex,
    local: SessionStatusIndex,
  ): SessionStatusIndex | undefined {
    const postStamp = this.postStampKeys(version, this.status)
    if (!postStamp) return undefined
    const merged: SessionStatusIndex = { ...snapshot }
    for (const sessionID of postStamp) {
      const value = local[sessionID]
      if (value === undefined) delete merged[sessionID]
      else merged[sessionID] = value
    }
    return merged
  }

  /**
   * Status keys a Scope bootstrap snapshot must contribute to the global index,
   * plus the stale entries it must clear.
   *
   * The snapshot is the only source for sessions that were already running
   * before this client connected: no status event will follow for them, so
   * without this the index renders them as idle until their next transition.
   * A status event that landed after the response stamp is newer and wins.
   *
   * The per-Scope bucket converged including deletions, so this does too: a
   * session the Scope still owns but the snapshot no longer reports as running
   * is one whose `idle` event (or archive) the client missed, and its stale
   * entry must not survive a fail-open resync. Sessions outside the owned list
   * belong to other Scopes and are untouched — a flat index cannot treat one
   * Scope's response as authoritative for sessions it never claimed. The owned
   * list is the bootstrap page, capped at the server page size, which matches
   * the reach the per-Scope bucket had.
   */
  adoptScopeStatusSnapshot(
    version: EventWriteStamp | undefined,
    snapshot: SessionStatusIndex,
    scopeSessionIDs: Iterable<string>,
  ): ScopeStatusSnapshotAdoption {
    const postStamp = this.postStampKeys(version, this.status)
    const adopt: SessionStatusIndex = {}
    for (const [sessionID, status] of Object.entries(snapshot)) {
      if (postStamp?.has(sessionID)) continue
      adopt[sessionID] = status
    }
    const drop: string[] = []
    for (const sessionID of scopeSessionIDs) {
      if (snapshot[sessionID] !== undefined || postStamp?.has(sessionID)) continue
      drop.push(sessionID)
    }
    return { adopt, drop }
  }

  /** Snapshot overlaid with post-stamp request upserts, in id order. */
  mergeRequests<T extends { id: string }>(
    version: EventWriteStamp | undefined,
    kind: "permission" | "question",
    snapshot: readonly T[],
    local: readonly T[],
  ): T[] | undefined {
    const postStamp = this.postStampKeys(version, kind === "permission" ? this.permission : this.question)
    if (!postStamp) return undefined
    const localByID = new Map(local.map((item) => [item.id, item]))
    const merged: T[] = []
    for (const item of snapshot) {
      if (postStamp.has(item.id)) continue
      merged.push(item)
    }
    for (const id of postStamp) {
      const item = localByID.get(id)
      if (item) merged.push(item)
    }
    return merged.toSorted((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Snapshot overlaid with post-stamp Cortex task writes.
   *
   * `Cortex.listVisible()` is process-global rather than Scope-scoped, so any
   * Scope's bootstrap response carries the whole visible task set and one
   * response is authoritative for the entire index. A whole-bucket
   * `cortex.tasks.updated` that postdates the response wins outright;
   * otherwise only the tasks an event wrote after the response stamp are
   * overlaid, so a task that finished while the response was in flight is not
   * reverted to its snapshot status. `undefined` means the snapshot is
   * authoritative for every task.
   */
  mergeCortex<T extends { id: string }>(
    version: EventWriteStamp | undefined,
    snapshot: readonly T[],
    local: readonly T[],
  ): T[] | undefined {
    if (!version || this.epoch !== version.epoch) return undefined
    if (this.cortexReplaceSeq !== undefined && this.cortexReplaceSeq > version.seq) return local.slice()
    const upsertIDs = new Set<string>()
    const upserts: T[] = []
    for (const [id, seq] of this.cortex) {
      if (seq <= version.seq) continue
      const entry = local.find((item) => item.id === id)
      if (entry) {
        upsertIDs.add(id)
        upserts.push(entry)
      }
    }
    if (upserts.length === 0) return undefined
    return [...upserts, ...snapshot.filter((item) => !upsertIDs.has(item.id))]
  }

  private postStampKeys(version: EventWriteStamp | undefined, writes: Map<string, number>): Set<string> | undefined {
    if (!version || this.epoch !== version.epoch) return undefined
    let keys: Set<string> | undefined
    for (const [id, seq] of writes) {
      if (seq <= version.seq) continue
      ;(keys ??= new Set()).add(id)
    }
    return keys
  }

  private syncEpoch(stamp: EventWriteStamp) {
    if (this.epoch === stamp.epoch) return
    this.epoch = stamp.epoch
    this.status.clear()
    this.permission.clear()
    this.question.clear()
    this.cortex.clear()
    this.cortexReplaceSeq = undefined
  }
}
