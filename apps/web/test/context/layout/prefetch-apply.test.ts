import { describe, expect, test } from "bun:test"
import { planPrefetchApply } from "../../../src/context/layout/prefetch-apply"

const message = (id: string, created: number) => ({
  id,
  time: { created },
  role: "assistant" as const,
})

const page = (items: Array<{ info: ReturnType<typeof message>; parts: Array<{ id: string }> }>) => ({
  items,
  referencedRoots: [],
  nextCursor: null,
  hasMore: false,
  total: items.length,
})

describe("planPrefetchApply", () => {
  test("marks the page as retry when any part bucket requires a newer snapshot", () => {
    const result = planPrefetchApply({
      page: page([
        { info: message("m1", 1), parts: [{ id: "p1" }] },
        { info: message("m2", 2), parts: [{ id: "p2" }] },
      ]),
      partSnapshotAction: (messageID) => (messageID === "m2" ? "retry" : "apply"),
    })
    expect(result.status).toBe("retry")
  })

  test("excludes preserved part buckets from the applied plan", () => {
    const result = planPrefetchApply({
      page: page([
        { info: message("m1", 1), parts: [{ id: "p1" }] },
        { info: message("m2", 2), parts: [{ id: "p2" }] },
      ]),
      partSnapshotAction: (messageID) => (messageID === "m1" ? "preserve" : "apply"),
    })
    if (result.status !== "applied") throw new Error("expected applied")
    expect(Object.keys(result.parts)).toEqual(["m2"])
    // The message window itself still applies: the resource-level freshness
    // token already accepted the page, and only the live part bucket for m1
    // must be kept.
    expect(result.window.messages.map((m) => m.id)).toEqual(["m1", "m2"])
  })

  test("applies every part bucket when no snapshot conflict exists", () => {
    const result = planPrefetchApply({
      page: page([{ info: message("m1", 1), parts: [{ id: "p1" }, { id: "p2" }] }]),
      partSnapshotAction: () => "apply",
    })
    if (result.status !== "applied") throw new Error("expected applied")
    expect(Object.keys(result.parts)).toEqual(["m1"])
    expect(result.parts["m1"]?.map((p) => p.id)).toEqual(["p1", "p2"])
    expect(result.metadata.hasMore).toBe(false)
  })
})
