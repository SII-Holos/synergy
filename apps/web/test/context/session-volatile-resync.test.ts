import { describe, expect, test } from "bun:test"
import { planSessionVolatileResync } from "../../src/context/session-volatile-resync"

describe("planSessionVolatileResync", () => {
  test("refreshes the active session in this scope while invalidating all retained state", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKey: "/workspace/project\nses_active",
        inboxSessionIDs: ["ses_active", "ses_board", "ses_inactive"],
        todoSessionIDs: ["ses_inactive"],
        dagSessionIDs: ["ses_other"],
      }),
    ).toEqual({
      activeSessionIDs: ["ses_active"],
      retainedSessionIDs: ["ses_active", "ses_board", "ses_inactive", "ses_other"],
    })
  })

  test("does not refresh a session owned by another scope", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKey: "/workspace/other\nses_active",
        inboxSessionIDs: ["ses_cached", "ses_board"],
        todoSessionIDs: [],
        dagSessionIDs: [],
      }),
    ).toEqual({
      activeSessionIDs: [],
      retainedSessionIDs: ["ses_cached", "ses_board"],
    })
  })

  test("no active bucket keeps no volatile state fresh", () => {
    expect(
      planSessionVolatileResync({
        scopeKey: "/workspace/project",
        activeBucketKey: undefined,
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
