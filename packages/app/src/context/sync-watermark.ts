// Client-side event watermark tracking (frontend sync redesign, phase 1).
//
// Each scope tracks the highest state-event seq it has applied, plus the server
// epoch. This powers reconnect replay (ask the server for events since the
// watermark) and light gap detection. Streaming events (part deltas) carry no
// seq and never move the watermark — they are applied unconditionally.

export type Watermark = { epoch: string; seq: number }

export type WatermarkObservation = {
  /** The watermark to store (unchanged while recovery is required). */
  next: Watermark | undefined
  /** The watermark recovery must replay from before applying the incoming event. */
  replayFrom: Watermark | undefined
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
    return { next: current, replayFrom: undefined, gap: false, epochChanged: false }
  }
  if (!current) {
    return {
      next: { epoch: incoming.epoch, seq: incoming.seq },
      replayFrom: undefined,
      gap: false,
      epochChanged: false,
    }
  }
  if (incoming.epoch !== current.epoch) {
    return { next: current, replayFrom: current, gap: false, epochChanged: true }
  }
  if (incoming.seq <= current.seq) {
    // Duplicate or already-applied event; keep the watermark, drop nothing else.
    return { next: current, replayFrom: undefined, gap: false, epochChanged: false }
  }
  const gap = incoming.seq > current.seq + 1
  if (gap) return { next: current, replayFrom: current, gap: true, epochChanged: false }
  return {
    next: { epoch: incoming.epoch, seq: incoming.seq },
    replayFrom: undefined,
    gap: false,
    epochChanged: false,
  }
}
