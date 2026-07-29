import { describe, expect, test } from "bun:test"
import {
  describeToolPartApply,
  planSessionSyncReload,
  queueSessionSync,
  refreshSessionAfterPending,
  sessionSyncWatchKey,
  shouldRunSessionSync,
  sessionSyncTargetSatisfiedBy,
  trackSessionSync,
} from "../../src/context/session-sync-plan"

describe("session sync watch key", () => {
  const key = (input: { sessionID?: string; connected?: boolean; ready?: boolean; reconnectVersion?: number }) =>
    sessionSyncWatchKey({
      sessionID: input.sessionID ?? "ses_1",
      connected: input.connected ?? true,
      ready: input.ready ?? true,
      reconnectVersion: input.reconnectVersion ?? 4,
    })

  test("includes connection, readiness, and recovered reconnect generation", () => {
    const before = key({})
    const after = key({ reconnectVersion: 5 })

    expect(before).toEqual(["ses_1", true, true, 4])
    expect(after).toEqual(["ses_1", true, true, 5])
    expect(after).not.toEqual(before)
  })

  test("runs for an initially ready session", () => {
    expect(shouldRunSessionSync(key({}))).toBe(true)
  })

  test("waits until the scope is connected and ready", () => {
    expect(shouldRunSessionSync(key({ connected: false }))).toBe(false)
    expect(shouldRunSessionSync(key({ ready: false }))).toBe(false)
    expect(shouldRunSessionSync(key({ sessionID: "" }))).toBe(false)
  })

  test("does not run on raw reconnect before recovery completes", () => {
    const disconnected = key({ connected: false })
    const reconnected = key({ connected: true })

    expect(shouldRunSessionSync(reconnected, disconnected)).toBe(false)
  })

  test("runs after the completed reconnect generation advances", () => {
    const reconnected = key({ reconnectVersion: 4 })
    const recovered = key({ reconnectVersion: 5 })

    expect(shouldRunSessionSync(recovered, reconnected)).toBe(true)
  })

  test("runs when navigating to another ready session", () => {
    expect(shouldRunSessionSync(key({ sessionID: "ses_2" }), key({ sessionID: "ses_1" }))).toBe(true)
  })
})

describe("planSessionSyncReload (#509)", () => {
  test("short-circuits when session and messages are current", () => {
    expect(
      planSessionSyncReload({
        hasSessionRecord: true,
        hasMessages: true,
        reconnectVersion: 2,
        lastSyncedReconnectVersion: 2,
        canUnrollback: false,
      }),
    ).toEqual({
      versionStale: false,
      needsDerivedHistoryRefresh: false,
      forceSession: false,
      forceMessages: false,
      ready: true,
    })
  })

  test("refreshes only authoritative session metadata after a workspace transition", () => {
    expect(
      planSessionSyncReload({
        hasSessionRecord: true,
        hasMessages: true,
        reconnectVersion: 2,
        lastSyncedReconnectVersion: 2,
        canUnrollback: false,
        trigger: { type: "workspace-transition" },
      }),
    ).toEqual({
      versionStale: false,
      needsDerivedHistoryRefresh: false,
      forceSession: true,
      forceMessages: false,
      ready: false,
    })
  })

  test("refreshes authoritative session metadata after a history transition", () => {
    expect(
      planSessionSyncReload({
        hasSessionRecord: true,
        hasMessages: true,
        reconnectVersion: 2,
        lastSyncedReconnectVersion: 2,
        canUnrollback: false,
        trigger: { type: "history-transition" },
      }),
    ).toEqual({
      versionStale: false,
      needsDerivedHistoryRefresh: false,
      forceSession: true,
      forceMessages: false,
      ready: false,
    })
  })

  test("forces message snapshot reload when reconnectVersion advances", () => {
    expect(
      planSessionSyncReload({
        hasSessionRecord: true,
        hasMessages: true,
        reconnectVersion: 3,
        lastSyncedReconnectVersion: 2,
        canUnrollback: false,
      }),
    ).toEqual({
      versionStale: true,
      needsDerivedHistoryRefresh: false,
      forceSession: true,
      forceMessages: true,
      ready: false,
    })
  })

  test("forces both loads on first sync after reconnect tracking starts", () => {
    expect(
      planSessionSyncReload({
        hasSessionRecord: true,
        hasMessages: true,
        reconnectVersion: 0,
        lastSyncedReconnectVersion: undefined,
        canUnrollback: false,
      }),
    ).toMatchObject({
      versionStale: true,
      forceSession: true,
      forceMessages: true,
      ready: false,
    })
  })

  test("loads missing messages without treating them as a reconnect", () => {
    expect(
      planSessionSyncReload({
        hasSessionRecord: true,
        hasMessages: false,
        reconnectVersion: 1,
        lastSyncedReconnectVersion: 1,
        canUnrollback: false,
      }),
    ).toEqual({
      versionStale: false,
      needsDerivedHistoryRefresh: false,
      forceSession: false,
      forceMessages: true,
      ready: false,
    })
  })

  test("refreshes when unrollback history requires a derived reload", () => {
    expect(
      planSessionSyncReload({
        hasSessionRecord: true,
        hasMessages: true,
        reconnectVersion: 4,
        lastSyncedReconnectVersion: 4,
        canUnrollback: true,
      }),
    ).toMatchObject({
      needsDerivedHistoryRefresh: true,
      forceSession: true,
      forceMessages: true,
      ready: false,
    })
  })
})

describe("refreshSessionAfterPending", () => {
  test("starts the authoritative refresh only after the stale request settles", async () => {
    let releasePending!: () => void
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve
    })
    const calls: string[] = []

    const refresh = refreshSessionAfterPending(pending, async () => {
      calls.push("refresh")
    })
    await Promise.resolve()

    expect(calls).toEqual([])
    releasePending()
    await refresh
    expect(calls).toEqual(["refresh"])
  })

  test("still refreshes authoritative metadata after the stale request fails", async () => {
    const calls: string[] = []

    await refreshSessionAfterPending(Promise.reject(new Error("stale request failed")), async () => {
      calls.push("refresh")
    })

    expect(calls).toEqual(["refresh"])
  })

  test("propagates an authoritative refresh failure", async () => {
    const failure = new Error("refresh failed")

    expect(refreshSessionAfterPending(Promise.resolve(), async () => Promise.reject(failure))).rejects.toBe(failure)
  })
})

describe("queueSessionSync", () => {
  const generation = (reconnectVersion: number) => ({ reconnectVersion, forceSession: true, forceMessages: true })

  test("queues a new reconnect generation behind an older inflight request", async () => {
    const inflight = new Map<string, import("../../src/context/session-sync-plan").TrackedSessionSync>()
    let releaseOlder!: () => void
    const calls: number[] = []
    const older = queueSessionSync(inflight, "ses_1", generation(4), async () => {
      calls.push(4)
      await new Promise<void>((resolve) => {
        releaseOlder = resolve
      })
    })
    const newer = queueSessionSync(inflight, "ses_1", generation(5), async () => {
      calls.push(5)
    })
    const duplicate = queueSessionSync(inflight, "ses_1", generation(5), async () => {
      calls.push(50)
    })

    expect(calls).toEqual([4])
    expect(duplicate).toBe(newer)
    releaseOlder()
    await older
    await newer
    expect(calls).toEqual([4, 5])
  })

  test("queues a stronger request within the same generation", async () => {
    const inflight = new Map<string, import("../../src/context/session-sync-plan").TrackedSessionSync>()
    let releaseMetadata!: () => void
    const calls: string[] = []
    const metadata = queueSessionSync(
      inflight,
      "ses_1",
      { reconnectVersion: 2, forceSession: true, forceMessages: false },
      async () => {
        calls.push("metadata")
        await new Promise<void>((resolve) => {
          releaseMetadata = resolve
        })
      },
    )
    const snapshot = queueSessionSync(inflight, "ses_1", generation(2), async () => {
      calls.push("snapshot")
    })

    expect(sessionSyncTargetSatisfiedBy(generation(2), generation(2))).toBe(true)
    expect(calls).toEqual(["metadata"])
    releaseMetadata()
    await metadata
    await snapshot
    expect(calls).toEqual(["metadata", "snapshot"])
  })
})

describe("trackSessionSync", () => {
  test("keeps the replacement request tracked until it settles", async () => {
    const inflight = new Map<string, import("../../src/context/session-sync-plan").TrackedSessionSync>()
    const target = { reconnectVersion: 1, forceSession: true, forceMessages: true }
    let releaseFirst!: () => void
    let releaseReplacement!: () => void
    const first = trackSessionSync(
      inflight,
      "ses_1",
      target,
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      }),
    )
    const replacement = trackSessionSync(
      inflight,
      "ses_1",
      target,
      first.then(
        () =>
          new Promise<void>((resolve) => {
            releaseReplacement = resolve
          }),
      ),
    )

    releaseFirst()
    await first
    await Promise.resolve()
    expect(inflight.get("ses_1")?.request).toBe(replacement)

    releaseReplacement()
    await replacement
    expect(inflight.has("ses_1")).toBe(false)
  })
})

describe("describeToolPartApply", () => {
  test("labels create/insert/reconcile actions for diagnostics", () => {
    expect(describeToolPartApply({ hasBucket: false, found: false })).toBe("create-bucket")
    expect(describeToolPartApply({ hasBucket: true, found: false })).toBe("insert")
    expect(describeToolPartApply({ hasBucket: true, found: true })).toBe("reconcile")
  })
})
