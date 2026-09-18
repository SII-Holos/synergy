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
   * Status keys a Scope bootstrap snapshot must contribute to the global index.
   *
   * The snapshot is the only source for sessions that were already running
   * before this client connected: no status event will follow for them, so
   * without this the index renders them as idle until their next transition.
   * A status event that landed after the response stamp is newer and wins.
   *
   * Only keys the snapshot actually carries are returned. The index spans every
   * Scope, so one Scope's response is not authoritative for the sessions it
   * omits — their convergence belongs to the cross-Scope snapshot.
   */
  adoptScopeStatusSnapshot(version: EventWriteStamp | undefined, snapshot: SessionStatusIndex): SessionStatusIndex {
    const postStamp = this.postStampKeys(version, this.status)
    if (!postStamp) return snapshot
    const adopted: SessionStatusIndex = {}
    for (const [sessionID, status] of Object.entries(snapshot)) {
      if (postStamp.has(sessionID)) continue
      adopted[sessionID] = status
    }
    return adopted
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
  }
}
