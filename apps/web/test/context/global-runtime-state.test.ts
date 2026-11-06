import { describe, expect, test } from "bun:test"
import { GlobalRuntimeWriteTracker } from "../../src/context/global-runtime-state"

describe("global status snapshot ordering", () => {
  test("preserves concurrent idle and busy writes across unrelated Scope clocks", () => {
    const tracker = new GlobalRuntimeWriteTracker()
    const request = tracker.captureStatusSnapshot()
    tracker.statusWrite({ epoch: "project", seq: 2 }, "finished")
    tracker.statusWrite({ epoch: "other-project", seq: 1 }, "started")
    tracker.cortexWrite({ epoch: "third-project", seq: 900 }, "unrelated-task")

    expect(
      tracker.mergeStatus(
        request,
        { finished: { type: "busy" }, unobserved: { type: "busy" } },
        { started: { type: "busy" } },
      ),
    ).toEqual({ started: { type: "busy" }, unobserved: { type: "busy" } })
  })

  test("a later snapshot clears pre-request stale work, including missed idle", () => {
    const tracker = new GlobalRuntimeWriteTracker()
    tracker.statusWrite({ epoch: "project", seq: 1 }, "stale")
    const request = tracker.captureStatusSnapshot()

    expect(tracker.mergeStatus(request, {}, { stale: { type: "busy" } })).toBeUndefined()
  })

  test("keeps a concurrent derived pause even without a sequenced status event", () => {
    const tracker = new GlobalRuntimeWriteTracker()
    const request = tracker.captureStatusSnapshot()
    tracker.statusWrite(undefined, "paused")
    const paused = { type: "paused" as const, reason: "aborted" as const, since: 1 }

    expect(tracker.mergeStatus(request, {}, { paused })).toEqual({ paused })
  })

  test("preserves a Scope snapshot repair without replacing its event watermark", () => {
    const tracker = new GlobalRuntimeWriteTracker()
    tracker.statusWrite({ epoch: "project", seq: 2 }, "finished")
    const request = tracker.captureStatusSnapshot()
    tracker.scopeStatusWrite("finished")

    expect(tracker.mergeStatus(request, { finished: { type: "busy" } }, {})).toEqual({})
    expect(
      tracker.adoptScopeStatusSnapshot({ epoch: "project", seq: 1 }, { finished: { type: "busy" } }, ["finished"]),
    ).toEqual({ adopt: {}, drop: [] })
  })
})

describe("Scope status snapshot ordering", () => {
  test("foreign status and Cortex events cannot erase the owning Scope's idle proof", () => {
    const tracker = new GlobalRuntimeWriteTracker()
    tracker.statusWrite({ epoch: "project", seq: 2 }, "finished")
    tracker.statusWrite({ epoch: "other-project", seq: 30 }, "other")
    tracker.cortexWrite({ epoch: "third-project", seq: 900 }, "unrelated-task")

    expect(
      tracker.adoptScopeStatusSnapshot({ epoch: "project", seq: 1 }, { finished: { type: "busy" } }, ["finished"]),
    ).toEqual({ adopt: {}, drop: [] })
    expect(tracker.adoptScopeStatusSnapshot({ epoch: "project", seq: 1 }, {}, ["finished"])).toEqual({
      adopt: {},
      drop: [],
    })
  })

  test("a newer or different-epoch Scope snapshot remains authoritative", () => {
    const tracker = new GlobalRuntimeWriteTracker()
    tracker.statusWrite({ epoch: "project", seq: 2 }, "session")

    expect(tracker.adoptScopeStatusSnapshot({ epoch: "project", seq: 3 }, {}, ["session"])).toEqual({
      adopt: {},
      drop: ["session"],
    })
    expect(
      tracker.adoptScopeStatusSnapshot({ epoch: "restarted-project", seq: 0 }, { session: { type: "busy" } }, [
        "session",
      ]),
    ).toEqual({ adopt: { session: { type: "busy" } }, drop: [] })
  })
})
