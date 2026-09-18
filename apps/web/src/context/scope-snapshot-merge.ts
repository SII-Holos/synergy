// Post-stamp event-write tracking for Scope bootstrap snapshots.
//
// The server stamps a snapshot response's sequence before reading its fields,
// so a same-epoch response whose seq trails an event already applied was read
// before that event happened. Events are authoritative for the buckets they
// write, but only for the keys they actually wrote after the stamp: a key last
// written before the stamp is older than the snapshot read and must converge
// to it (including the snapshot's deletions), or a missed archive leaves stale
// rows forever. ScopeWriteTracker records the last sequenced event write per
// key (plus whole-bucket Cortex replacements and session archive tombstones);
// snapshot application then overlays only qualifying keys onto the snapshot.

export type EventWriteStamp = { epoch: string; seq: number }

export function parseEventWriteStamp(
  event: { epoch?: unknown; seq?: unknown } | undefined,
): EventWriteStamp | undefined {
  if (typeof event?.epoch !== "string" || typeof event?.seq !== "number") return undefined
  return { epoch: event.epoch, seq: event.seq }
}

export class ScopeWriteTracker {
  private epoch: string | undefined
  private readonly sessions = new Map<string, { seq: number; present: boolean }>()
  private readonly cortex = new Map<string, number>()
  private cortexReplaceSeq: number | undefined

  sessionWrite(stamp: EventWriteStamp, sessionID: string, present: boolean) {
    this.syncEpoch(stamp)
    this.sessions.set(sessionID, { seq: stamp.seq, present })
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

  // Post-stamp whole-bucket Cortex replacement wins entirely; otherwise the
  // snapshot is overlaid with post-stamp task upserts. Undefined when the
  // snapshot is authoritative for every task.
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

  private syncEpoch(stamp: EventWriteStamp) {
    if (this.epoch === stamp.epoch) return
    this.epoch = stamp.epoch
    this.sessions.clear()
    this.cortex.clear()
    this.cortexReplaceSeq = undefined
  }
}
