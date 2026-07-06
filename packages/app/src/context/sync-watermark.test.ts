import { describe, expect, test } from "bun:test"
import { observeWatermark } from "./sync-watermark"

describe("observeWatermark", () => {
  test("seeds from the first state event", () => {
    const r = observeWatermark(undefined, { epoch: "e1", seq: 5 })
    expect(r.next).toEqual({ epoch: "e1", seq: 5 })
    expect(r.gap).toBe(false)
    expect(r.epochChanged).toBe(false)
  })

  test("ignores streaming/non-state events (no seq)", () => {
    const current = { epoch: "e1", seq: 5 }
    const r = observeWatermark(current, { epoch: undefined, seq: undefined })
    expect(r.next).toBe(current)
    expect(r.gap).toBe(false)
  })

  test("advances on the next contiguous seq without a gap", () => {
    const r = observeWatermark({ epoch: "e1", seq: 5 }, { epoch: "e1", seq: 6 })
    expect(r.next).toEqual({ epoch: "e1", seq: 6 })
    expect(r.gap).toBe(false)
  })

  test("flags a gap when a seq is skipped", () => {
    const r = observeWatermark({ epoch: "e1", seq: 5 }, { epoch: "e1", seq: 8 })
    expect(r.next).toEqual({ epoch: "e1", seq: 8 })
    expect(r.gap).toBe(true)
  })

  test("keeps the watermark for duplicate/stale seqs", () => {
    const current = { epoch: "e1", seq: 5 }
    expect(observeWatermark(current, { epoch: "e1", seq: 5 }).next).toBe(current)
    expect(observeWatermark(current, { epoch: "e1", seq: 3 }).next).toBe(current)
    expect(observeWatermark(current, { epoch: "e1", seq: 3 }).gap).toBe(false)
  })

  test("flags an epoch change and adopts the new epoch/seq", () => {
    const r = observeWatermark({ epoch: "e1", seq: 100 }, { epoch: "e2", seq: 1 })
    expect(r.epochChanged).toBe(true)
    expect(r.next).toEqual({ epoch: "e2", seq: 1 })
  })
})
