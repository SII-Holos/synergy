import { describe, expect, test } from "bun:test"
import { SessionPartSnapshotFreshness } from "../../src/context/session-part-snapshot-freshness"

describe("session part snapshot freshness", () => {
  test("distinguishes authoritative apply from live overlay preservation", () => {
    const freshness = new SessionPartSnapshotFreshness()
    const request = freshness.capture("scope", "session")

    freshness.touch("scope", "session", "active")

    expect(freshness.action("scope", "session", "active", request)).toBe("preserve")
    expect(freshness.action("scope", "session", "history", request)).toBe("apply")
  })

  test("retries when an ignored mutation affects a returned message", () => {
    const freshness = new SessionPartSnapshotFreshness()
    const request = freshness.capture("scope", "session")

    freshness.touch("scope", "session", "outside-window", { requiresSnapshot: true })

    expect(freshness.action("scope", "session", "outside-window", request)).toBe("retry")
    expect(freshness.action("scope", "session", "unrelated", request)).toBe("apply")
  })

  test("accepts a request captured after a snapshot-required mutation", () => {
    const freshness = new SessionPartSnapshotFreshness()
    freshness.touch("scope", "session", "message", { requiresSnapshot: true })

    const request = freshness.capture("scope", "session")

    expect(freshness.action("scope", "session", "message", request)).toBe("apply")
  })

  test("invalidates captured requests when a scope is released", () => {
    const freshness = new SessionPartSnapshotFreshness()
    const request = freshness.capture("scope", "session")

    freshness.releaseScope("scope")

    expect(freshness.action("scope", "session", "message", request)).toBe("retry")
  })

  test("invalidates captured requests when a session is released", () => {
    const freshness = new SessionPartSnapshotFreshness()
    const request = freshness.capture("scope", "session")

    freshness.releaseSession("scope", "session")

    expect(freshness.action("scope", "session", "message", request)).toBe("retry")
  })
})
