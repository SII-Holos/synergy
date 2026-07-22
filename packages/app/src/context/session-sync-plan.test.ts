import { describe, expect, test } from "bun:test"
import { describeToolPartApply, planSessionSyncReload, refreshSessionAfterPending } from "./session-sync-plan"

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
})

describe("describeToolPartApply", () => {
  test("labels create/insert/reconcile actions for diagnostics", () => {
    expect(describeToolPartApply({ hasBucket: false, found: false })).toBe("create-bucket")
    expect(describeToolPartApply({ hasBucket: true, found: false })).toBe("insert")
    expect(describeToolPartApply({ hasBucket: true, found: true })).toBe("reconcile")
  })
})
