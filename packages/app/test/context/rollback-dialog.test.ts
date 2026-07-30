import { describe, expect, test } from "bun:test"
import { resolveRollbackDialogSeenKey } from "../../src/context/rollback-dialog"

describe("rollback dialog presentation state", () => {
  test("returns no seen key without an active session rollback", () => {
    expect(resolveRollbackDialogSeenKey({ sessionID: undefined, rollbackID: undefined })).toBeUndefined()
  })

  test("matching server acknowledgment suppresses the current rollback", () => {
    expect(
      resolveRollbackDialogSeenKey({
        sessionID: "session-a",
        rollbackID: "rollback-a",
        rollbackAck: { rollbackID: "rollback-a" },
      }),
    ).toBe("session-a:rollback-a")
  })

  test("page-local pending presentation suppresses the dialog until server sync arrives", () => {
    expect(
      resolveRollbackDialogSeenKey({
        sessionID: "session-a",
        rollbackID: "rollback-a",
        pendingKey: "session-a:rollback-a",
      }),
    ).toBe("session-a:rollback-a")
  })

  test("mismatched acknowledgment leaves a new rollback eligible", () => {
    expect(
      resolveRollbackDialogSeenKey({
        sessionID: "session-a",
        rollbackID: "rollback-b",
        rollbackAck: { rollbackID: "rollback-a" },
        pendingKey: "session-a:rollback-a",
      }),
    ).toBeUndefined()
  })
})
