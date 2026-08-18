import { describe, expect, test } from "bun:test"
import { planSessionVolatileResync } from "../../src/context/session-volatile-resync"

describe("planSessionVolatileResync", () => {
  test("refreshes every active session in this scope while invalidating all retained state", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKeys: ["/workspace/project\nses_active", "/workspace/project\nses_board"],
        inboxSessionIDs: ["ses_active", "ses_board", "ses_inactive"],
        todoSessionIDs: ["ses_inactive"],
        dagSessionIDs: ["ses_other"],
      }),
    ).toEqual({
      activeSessionIDs: ["ses_active", "ses_board"],
      retainedSessionIDs: ["ses_active", "ses_board", "ses_inactive", "ses_other"],
    })
  })

  test("does not refresh sessions owned by another scope", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKeys: ["/workspace/other\nses_active", "/workspace/project\nses_board"],
        inboxSessionIDs: ["ses_cached", "ses_board"],
        todoSessionIDs: [],
        dagSessionIDs: [],
      }),
    ).toEqual({
      activeSessionIDs: ["ses_board"],
      retainedSessionIDs: ["ses_cached", "ses_board"],
    })
  })

  test("an empty active set keeps no volatile buckets fresh", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKeys: [],
        inboxSessionIDs: ["ses_cached"],
        todoSessionIDs: [],
        dagSessionIDs: [],
      }),
    ).toEqual({
      activeSessionIDs: [],
      retainedSessionIDs: ["ses_cached"],
    })
  })
})
