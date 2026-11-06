import { describe, expect, test } from "bun:test"
import { observeWatermark } from "../../src/context/sync-watermark"

describe("observeWatermark", () => {
  test("omitted ranges advance contiguously while real gaps and malformed cursors require recovery", () => {
    const current = { epoch: "e1", seq: 5 }
    expect(observeWatermark(current, { epoch: "e1", seq: 20, fromSeq: 6, toSeq: 20 }).next).toEqual({
      epoch: "e1",
      seq: 20,
    })
    expect(observeWatermark(current, { epoch: "e1", seq: 20, fromSeq: 7, toSeq: 20 }).gap).toBe(true)
    expect(observeWatermark(current, { epoch: "e1", seq: 20, fromSeq: 6, toSeq: 19 }).gap).toBe(true)
    expect(observeWatermark(current, { epoch: "e2", seq: 20, fromSeq: 6, toSeq: 20 }).epochChanged).toBe(true)
  })
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

  test("keeps the pre-gap watermark as the replay starting point", () => {
    const current = { epoch: "e1", seq: 5 }
    const r = observeWatermark(current, { epoch: "e1", seq: 8 })
    expect(r.next).toBe(current)
    expect(r.replayFrom).toBe(current)
    expect(r.gap).toBe(true)
  })

  test("keeps the watermark for duplicate/stale seqs", () => {
    const current = { epoch: "e1", seq: 5 }
    expect(observeWatermark(current, { epoch: "e1", seq: 5 }).next).toBe(current)
    expect(observeWatermark(current, { epoch: "e1", seq: 3 }).next).toBe(current)
    expect(observeWatermark(current, { epoch: "e1", seq: 3 }).gap).toBe(false)
  })

  test("keeps the previous epoch until authoritative resync", () => {
    const current = { epoch: "e1", seq: 100 }
    const r = observeWatermark(current, { epoch: "e2", seq: 1 })
    expect(r.epochChanged).toBe(true)
    expect(r.next).toBe(current)
    expect(r.replayFrom).toBe(current)
  })
})

test("an invalid first cursor cannot seed a watermark", () => {
  const result = observeWatermark(undefined, { epoch: "epoch", seq: 4, fromSeq: 8, toSeq: 4 })
  expect(result.next).toBeUndefined()
  expect(result.gap).toBe(true)
})
