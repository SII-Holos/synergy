// Post-stamp event-write tracking for Scope bootstrap snapshots.
//
// The server stamps a snapshot response's sequence before reading its fields,
// so a same-epoch response whose seq trails an event already applied was read
// before that event happened. Events are authoritative for the buckets they
// write, but only for the keys they actually wrote after the stamp: a key last
// written before the stamp is older than the snapshot read and must converge
// to it (including the snapshot's deletions), or a missed archive leaves stale
// rows forever. ScopeWriteTracker records the last sequenced event write per
// session id (plus archive tombstones); snapshot application then overlays only
// qualifying keys onto the snapshot.

export type EventWriteStamp = { epoch: string; seq: number }

export function parseEventWriteStamp(
  event: { epoch?: unknown; seq?: unknown } | undefined,
): EventWriteStamp | undefined {
  if (typeof event?.epoch !== "string" || typeof event?.seq !== "number") return undefined
  return { epoch: event.epoch, seq: event.seq }
}

export class ScopeWriteTracker {
  private epoch: string | undefined
  private readonly workspaces = new Map<string, number>()
  private readonly sessions = new Map<string, { seq: number; present: boolean }>()

  sessionWrite(stamp: EventWriteStamp, sessionID: string, present: boolean) {
    this.syncEpoch(stamp)
    this.sessions.set(sessionID, { seq: stamp.seq, present })
  }

  // Snapshot overlaid with post-stamp session upserts and stripped of
  // post-stamp archive tombstones; undefined when nothing qualifies.
  mergeSessions<T extends { id: string }>(
    version: EventWriteStamp | undefined,
    snapshot: readonly T[],
    local: readonly T[],
  ): T[] | undefined {
    if (!version || this.epoch !== version.epoch) return undefined
    const upsertIDs = new Set<string>()
    const upserts: T[] = []
    let tombstones: Set<string> | undefined
    for (const [id, write] of this.sessions) {
      if (write.seq <= version.seq) continue
      if (!write.present) {
        ;(tombstones ??= new Set()).add(id)
        continue
      }
      const entry = local.find((item) => item.id === id)
      if (entry) {
        upsertIDs.add(id)
        upserts.push(entry)
      }
    }
    if (!tombstones && upserts.length === 0) return undefined
    return [...upserts, ...snapshot.filter((item) => !tombstones?.has(item.id) && !upsertIDs.has(item.id))]
  }

  workspaceWrite(stamp: EventWriteStamp, workspaceID: string) {
    this.syncEpoch(stamp)
    this.workspaces.set(workspaceID, stamp.seq)
  }

  mergeWorkspaces<T extends { id: string }>(
    version: EventWriteStamp | undefined,
    snapshot: readonly T[],
    local: readonly T[],
  ): T[] {
    if (!version || this.epoch !== version.epoch) return [...snapshot]
    const newer = local.filter((record) => (this.workspaces.get(record.id) ?? -1) > version.seq)
    const ids = new Set(newer.map((record) => record.id))
    return [...snapshot.filter((record) => !ids.has(record.id)), ...newer]
  }

  private syncEpoch(stamp: EventWriteStamp) {
    if (this.epoch === stamp.epoch) return
    this.epoch = stamp.epoch
    this.sessions.clear()
    this.workspaces.clear()
  }
}
