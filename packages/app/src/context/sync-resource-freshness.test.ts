import { describe, expect, test } from "bun:test"
import { SyncResourceFreshness, type SyncVersion } from "./sync-resource-freshness"

const scope = "/workspace/project"
const session = "ses_progress"
const dag = { scopeKey: scope, sessionID: session, resource: "dag" as const }
const todo = { scopeKey: scope, sessionID: session, resource: "todo" as const }
const version = (seq: number, epoch = "epoch-1"): SyncVersion => ({ epoch, seq })

describe("SyncResourceFreshness", () => {
  test("rejects a stale DAG snapshot after a newer event", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(11))).toBe(true)
    expect(freshness.acceptSnapshot(dag, version(10))).toBe(false)
    expect(freshness.current(dag)).toEqual(version(11))
  })

  test("accepts snapshots at or above the current resource sequence", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(10))).toBe(true)
    expect(freshness.acceptSnapshot(dag, version(10))).toBe(true)
    expect(freshness.acceptSnapshot(dag, version(12))).toBe(true)
    expect(freshness.current(dag)).toEqual(version(12))
  })

  test("accepts an initial snapshot despite unrelated scope events", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(todo, version(20))).toBe(true)
    expect(freshness.acceptSnapshot(dag, version(10))).toBe(true)
    expect(freshness.current(dag)).toEqual(version(10))
  })

  test("isolates freshness by session and resource", () => {
    const freshness = new SyncResourceFreshness()
    const otherSession = { ...dag, sessionID: "ses_other" }

    expect(freshness.acceptEvent(dag, version(30))).toBe(true)
    expect(freshness.acceptSnapshot(todo, version(5))).toBe(true)
    expect(freshness.acceptSnapshot(otherSession, version(4))).toBe(true)
  })

  test("rejects duplicate and older replay events after a snapshot", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptSnapshot(dag, version(15))).toBe(true)
    expect(freshness.acceptEvent(dag, version(15))).toBe(false)
    expect(freshness.acceptEvent(dag, version(14))).toBe(false)
    expect(freshness.acceptEvent(dag, version(16))).toBe(true)
  })

  test("switches epoch on an authoritative event and rejects delayed old snapshots", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptSnapshot(dag, version(50, "epoch-old"))).toBe(true)
    expect(freshness.acceptEvent(dag, version(1, "epoch-new"))).toBe(true)
    expect(freshness.current(dag)).toEqual(version(1, "epoch-new"))
    expect(freshness.acceptSnapshot(dag, version(51, "epoch-old"))).toBe(false)
  })

  test("reset establishes the authoritative epoch and clears resource versions", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(8, "epoch-old"))).toBe(true)
    freshness.resetScope(scope, "epoch-new")

    expect(freshness.current(dag)).toBeUndefined()
    expect(freshness.acceptSnapshot(dag, version(0, "epoch-new"))).toBe(true)
    expect(freshness.acceptSnapshot(todo, version(9, "epoch-old"))).toBe(false)
  })

  test("invalidates an asynchronous resource callback after a newer event", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(21))).toBe(true)
    const request = freshness.capture(dag)
    expect(freshness.unchanged(dag, request)).toBe(true)
    expect(freshness.acceptEvent(dag, version(22))).toBe(true)
    expect(freshness.unchanged(dag, request)).toBe(false)
  })

  test("accepts unversioned inputs and clears the resource comparison version", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(7))).toBe(true)
    expect(freshness.acceptSnapshot(dag, undefined)).toBe(true)
    expect(freshness.current(dag)).toBeUndefined()
    expect(freshness.acceptEvent(dag, undefined)).toBe(true)
    expect(freshness.current(dag)).toBeUndefined()
  })

  test("rejects an unversioned response when an event arrives in flight", () => {
    const freshness = new SyncResourceFreshness()
    const request = freshness.capture(dag)

    expect(freshness.acceptEvent(dag, version(4))).toBe(true)
    expect(freshness.acceptResponse(dag, request, undefined)).toBe(false)
    expect(freshness.current(dag)).toEqual(version(4))
  })

  test("accepts only non-stale versioned responses after an in-flight event", () => {
    const freshness = new SyncResourceFreshness()
    const staleRequest = freshness.capture(dag)

    expect(freshness.acceptEvent(dag, version(10))).toBe(true)
    expect(freshness.acceptResponse(dag, staleRequest, version(9))).toBe(false)

    const currentRequest = freshness.capture(dag)
    expect(freshness.acceptEvent(dag, version(11))).toBe(true)
    expect(freshness.acceptResponse(dag, currentRequest, version(11))).toBe(true)
  })

  test("rejects responses captured before a scope reset", () => {
    const freshness = new SyncResourceFreshness()
    const request = freshness.capture(dag)

    freshness.resetScope(scope, "epoch-new", 8)
    expect(freshness.acceptResponse(dag, request, version(9, "epoch-new"))).toBe(false)
    expect(freshness.acceptSnapshot(dag, version(7, "epoch-new"))).toBe(false)
    expect(freshness.acceptEvent(dag, version(7, "epoch-new"))).toBe(false)
    expect(freshness.acceptSnapshot(dag, version(8, "epoch-new"))).toBe(true)
  })

  test("does not return to a retired epoch", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(20, "epoch-old"))).toBe(true)
    freshness.resetScope(scope, "epoch-new", 1)
    expect(freshness.acceptEvent(dag, version(21, "epoch-old"))).toBe(false)
    expect(freshness.acceptSnapshot(dag, version(21, "epoch-old"))).toBe(false)
  })
  test("switches epoch on a non-resource event and invalidates in-flight responses", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(20, "epoch-old"))).toBe(true)
    const request = freshness.capture(dag)
    expect(freshness.acceptScopeEvent(scope, version(5, "epoch-new"))).toBe(true)
    expect(freshness.unchanged(dag, request)).toBe(false)
    expect(freshness.acceptSnapshot(dag, version(4, "epoch-new"))).toBe(false)
    expect(freshness.acceptSnapshot(dag, version(5, "epoch-new"))).toBe(true)
    expect(freshness.acceptScopeEvent(scope, version(21, "epoch-old"))).toBe(false)
  })

  test("release removes the scope epoch and all resource versions", () => {
    const freshness = new SyncResourceFreshness()

    expect(freshness.acceptEvent(dag, version(7))).toBe(true)
    freshness.releaseScope(scope)

    expect(freshness.current(dag)).toBeUndefined()
    expect(freshness.acceptSnapshot(dag, version(2, "epoch-recreated"))).toBe(true)
  })
})
