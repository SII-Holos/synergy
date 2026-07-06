// Client-side event watermark tracking (frontend sync redesign, phase 1).
//
// Each scope tracks the highest state-event seq it has applied, plus the server
// epoch. This powers reconnect replay (ask the server for events since the
// watermark) and light gap detection. Streaming events (part deltas) carry no
// seq and never move the watermark — they are applied unconditionally.

export type Watermark = { epoch: string; seq: number }

export type WatermarkObservation = {
  /** The watermark to store (unchanged for stale/streaming events). */
  next: Watermark | undefined
  /** A seq gap was detected — the caller should replay to fill it. */
  gap: boolean
  /** The server epoch changed (runtime restarted) — the caller should resync. */
  epochChanged: boolean
}

export function observeWatermark(
  current: Watermark | undefined,
  incoming: { epoch?: string; seq?: number } | undefined,
): WatermarkObservation {
  // Streaming / non-state events (no seq) don't move the watermark.
  if (!incoming || incoming.seq === undefined || incoming.epoch === undefined) {
    return { next: current, gap: false, epochChanged: false }
  }
  if (!current) {
    return { next: { epoch: incoming.epoch, seq: incoming.seq }, gap: false, epochChanged: false }
  }
  if (incoming.epoch !== current.epoch) {
    // Runtime restarted; adopt the new epoch/seq and signal a resync.
    return { next: { epoch: incoming.epoch, seq: incoming.seq }, gap: false, epochChanged: true }
  }
  if (incoming.seq <= current.seq) {
    // Duplicate or already-applied event; keep the watermark, drop nothing else.
    return { next: current, gap: false, epochChanged: false }
  }
  const gap = incoming.seq > current.seq + 1
  return { next: { epoch: incoming.epoch, seq: incoming.seq }, gap, epochChanged: false }
}
