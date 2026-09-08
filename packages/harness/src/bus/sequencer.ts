// Per-scope event sequencer + replay journal (frontend sync redesign, phase 1).
//
// Only "state" events (session/message/status/inbox/...) are sequenced and
// journaled. High-frequency "stream" events (part deltas) are intentionally
// unsequenced: they are coalescible and self-healing (a full part follows), so
// they bypass gap detection and never create holes the client must replay.
//
// State event seqs are therefore contiguous (1..current minus the pruned
// prefix), which makes replay coverage a simple range check.

export type ReplayResult =
  | { status: "ok"; epoch: string; seq: number; events: unknown[] }
  | { status: "reset"; epoch: string; seq: number }

type JournalEntry = { seq: number; at: number; payload: unknown }

export class SyncSequencer {
  private counter = 0
  private entries: JournalEntry[] = []

  constructor(
    readonly epoch: string,
    private readonly maxEntries = 4096,
    private readonly maxAgeMs = 300_000,
  ) {}

  /** Highest allocated state seq. */
  get current(): number {
    return this.counter
  }

  /** Allocate the next state seq and journal the (already stamped) payload. */
  stamp(payload: { seq: number }, now: number): number {
    const seq = ++this.counter
    payload.seq = seq
    this.entries.push({ seq, at: now, payload })
    this.prune(now)
    return seq
  }

  private prune(now: number): void {
    const cutoff = now - this.maxAgeMs
    while (this.entries.length > 0 && (this.entries.length > this.maxEntries || this.entries[0].at < cutoff)) {
      this.entries.shift()
    }
  }

  /**
   * Return the state events after `sinceSeq`, or a reset instruction when the
   * client is too far behind (the needed events have been pruned) or ahead
   * (impossible under the current epoch). Callers should also compare epochs.
   */
  replay(sinceSeq: number, now: number): ReplayResult {
    this.prune(now)
    if (sinceSeq === this.counter) return { status: "ok", epoch: this.epoch, seq: this.counter, events: [] }
    if (sinceSeq > this.counter) return { status: "reset", epoch: this.epoch, seq: this.counter }
    const oldest = this.entries[0]?.seq
    if (oldest === undefined || sinceSeq + 1 < oldest) {
      return { status: "reset", epoch: this.epoch, seq: this.counter }
    }
    return {
      status: "ok",
      epoch: this.epoch,
      seq: this.counter,
      events: this.entries.filter((e) => e.seq > sinceSeq).map((e) => e.payload),
    }
  }
}
