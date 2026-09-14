import { describe, expect, test } from "bun:test"
import { mergeIdKeyedSnapshot, mergeSessionStatusSnapshot } from "../../src/context/scope-snapshot-merge"

describe("mergeSessionStatusSnapshot", () => {
  test("local event status wins over the older snapshot for the same session", () => {
    expect(mergeSessionStatusSnapshot({ a: { type: "idle" }, b: { type: "busy" } }, { a: { type: "busy" } })).toEqual({
      a: { type: "busy" },
      b: { type: "busy" },
    })
  })

  test("empty local map adopts the snapshot", () => {
    expect(mergeSessionStatusSnapshot({ a: { type: "busy" } }, {})).toEqual({ a: { type: "busy" } })
  })
})

describe("mergeIdKeyedSnapshot", () => {
  test("keeps local entries first and fills missing snapshot entries", () => {
    expect(mergeIdKeyedSnapshot([{ id: "snap" }, { id: "both" }], [{ id: "live" }, { id: "both" }])).toEqual([
      { id: "live" },
      { id: "both" },
      { id: "snap" },
    ])
  })

  test("empty local list adopts a copy of the snapshot", () => {
    const snapshot = [{ id: "snap" }]
    expect(mergeIdKeyedSnapshot(snapshot, [])).toEqual(snapshot)
    expect(mergeIdKeyedSnapshot(snapshot, [])).not.toBe(snapshot)
  })
})
