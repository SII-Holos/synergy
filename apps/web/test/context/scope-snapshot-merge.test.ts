import { describe, expect, test } from "bun:test"
import { parseEventWriteStamp, ScopeWriteTracker } from "../../src/context/scope-snapshot-merge"

const stamp = (seq: number, epoch = "e1") => ({ epoch, seq })

describe("ScopeWriteTracker.mergeSessions", () => {
  test("post-stamp upserts overlay the snapshot and tombstones filter it", () => {
    const tracker = new ScopeWriteTracker()
    tracker.sessionWrite(stamp(7), "kept", true)
    tracker.sessionWrite(stamp(8), "archived-after", false)
    const merged = tracker.mergeSessions(
      { epoch: "e1", seq: 6 },
      [{ id: "snap" }, { id: "archived-after" }],
      [{ id: "kept" }, { id: "snap" }],
    )
    expect(merged).toEqual([{ id: "kept" }, { id: "snap" }])
  })

  test("pre-stamp session writes converge to the snapshot", () => {
    const tracker = new ScopeWriteTracker()
    tracker.sessionWrite(stamp(3), "old-live", true)
    expect(tracker.mergeSessions({ epoch: "e1", seq: 6 }, [{ id: "snap" }], [{ id: "old-live" }])).toBeUndefined()
  })
})

describe("parseEventWriteStamp", () => {
  test("accepts string epoch with number seq and rejects anything else", () => {
    expect(parseEventWriteStamp({ epoch: "e1", seq: 3 })).toEqual({ epoch: "e1", seq: 3 })
    expect(parseEventWriteStamp({ seq: 3 })).toBeUndefined()
    expect(parseEventWriteStamp({ epoch: "e1", seq: "3" })).toBeUndefined()
    expect(parseEventWriteStamp(undefined)).toBeUndefined()
  })
})
