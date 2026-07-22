import { describe, expect, test } from "bun:test"
import { planSessionVolatileResync } from "../../src/context/session-volatile-resync"

describe("planSessionVolatileResync", () => {
  test("refreshes only the active session while invalidating all retained state", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKey: "/workspace/project\nses_active",
        inboxSessionIDs: ["ses_active", "ses_inactive"],
        todoSessionIDs: ["ses_inactive"],
        dagSessionIDs: ["ses_other"],
      }),
    ).toEqual({
      activeSessionID: "ses_active",
      retainedSessionIDs: ["ses_active", "ses_inactive", "ses_other"],
    })
  })

  test("does not refresh an active session owned by another scope", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKey: "/workspace/other\nses_active",
        inboxSessionIDs: ["ses_cached"],
        todoSessionIDs: [],
        dagSessionIDs: [],
      }),
    ).toEqual({
      activeSessionID: undefined,
      retainedSessionIDs: ["ses_cached"],
    })
  })
})
