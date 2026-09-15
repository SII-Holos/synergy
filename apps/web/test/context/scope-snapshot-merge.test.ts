import { describe, expect, test } from "bun:test"
import { parseEventWriteStamp, ScopeWriteTracker } from "../../src/context/scope-snapshot-merge"

const stamp = (seq: number, epoch = "e1") => ({ epoch, seq })

describe("ScopeWriteTracker.mergeStatus", () => {
  test("post-stamp status writes keep their event value", () => {
    const tracker = new ScopeWriteTracker()
    tracker.statusWrite(stamp(5), "missed-idle")
    tracker.statusWrite(stamp(7), "fresh-busy")
    expect(tracker.mergeStatus({ epoch: "e1", seq: 6 }, {}, { "fresh-busy": { type: "busy" } })).toEqual({
      "fresh-busy": { type: "busy" },
    })
  })

  test("pre-stamp writes converge to the snapshot (stale busy is cleared)", () => {
    const tracker = new ScopeWriteTracker()
    tracker.statusWrite(stamp(5), "missed-idle")
    expect(tracker.mergeStatus({ epoch: "e1", seq: 6 }, {}, { "missed-idle": { type: "busy" } })).toBeUndefined()
  })

  test("epoch change resets tracking so the snapshot is authoritative", () => {
    const tracker = new ScopeWriteTracker()
    tracker.statusWrite(stamp(7), "busy-session")
    expect(tracker.mergeStatus({ epoch: "e2", seq: 1 }, {}, { "busy-session": { type: "busy" } })).toBeUndefined()
  })
})

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

describe("ScopeWriteTracker.mergeCortex", () => {
  test("post-stamp whole-bucket replacement wins entirely", () => {
    const tracker = new ScopeWriteTracker()
    tracker.cortexWrite(stamp(8), "task-live")
    tracker.cortexReplace(stamp(9))
    expect(tracker.mergeCortex({ epoch: "e1", seq: 6 }, [{ id: "snap-task" }], [])).toEqual([])
  })

  test("post-stamp task upserts overlay the snapshot", () => {
    const tracker = new ScopeWriteTracker()
    tracker.cortexWrite(stamp(7), "task-live")
    expect(tracker.mergeCortex({ epoch: "e1", seq: 6 }, [{ id: "snap-task" }], [{ id: "task-live" }])).toEqual([
      { id: "task-live" },
      { id: "snap-task" },
    ])
  })

  test("pre-stamp task writes converge to the snapshot", () => {
    const tracker = new ScopeWriteTracker()
    tracker.cortexWrite(stamp(5), "old-task")
    expect(tracker.mergeCortex({ epoch: "e1", seq: 6 }, [{ id: "snap-task" }], [{ id: "old-task" }])).toBeUndefined()
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
