import { describe, expect, test } from "bun:test"
import {
  describeToolPartApply,
  planSessionSyncReload,
  refreshSessionAfterPending,
  trackSessionSync,
} from "../../src/context/session-sync-plan"

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

describe("trackSessionSync", () => {
  test("keeps the replacement request tracked until it settles", async () => {
    const inflight = new Map<string, Promise<void>>()
    let releaseFirst!: () => void
    let releaseReplacement!: () => void
    const first = trackSessionSync(
      inflight,
      "ses_1",
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      }),
    )
    const replacement = trackSessionSync(
      inflight,
      "ses_1",
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
    expect(inflight.get("ses_1")).toBe(replacement)

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
