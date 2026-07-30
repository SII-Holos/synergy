import { describe, expect, test } from "bun:test"
import { rollbackDialogAction } from "../../../src/components/session/rollback-dialog-model"

describe("rollback dialog presentation", () => {
  test("waits for the current modal to close before showing rollback feedback", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-a",
        activeDialogID: "rewind-confirm",
      }),
    ).toBe("wait")

    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-a",
      }),
    ).toBe("show")
  })

  test("matching seen key suppresses the current rollback", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-a",
        seenKey: "session-a:rollback-a",
      }),
    ).toBe("wait")
  })

  test("missing seen key shows dialog for an active rollback", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-a",
      }),
    ).toBe("show")
  })

  test("mismatched seen key shows dialog for a new rollback", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-b",
        seenKey: "session-a:rollback-a",
      }),
    ).toBe("show")
  })

  test("closes an obsolete rollback dialog before presenting newer state", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: undefined,
        activeDialogID: "rollback-dialog",
        rollbackDialogID: "rollback-dialog",
        activeRollbackKey: "session-a:rollback-a",
      }),
    ).toBe("close")

    expect(
      rollbackDialogAction({
        rollbackKey: "session-b:rollback-b",
        activeDialogID: "rollback-dialog",
        rollbackDialogID: "rollback-dialog",
        activeRollbackKey: "session-a:rollback-a",
      }),
    ).toBe("close")
  })

  test("obsolete active dialog still closes when no rollback is active", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: undefined,
        activeDialogID: "rollback-dialog",
        rollbackDialogID: "rollback-dialog",
        activeRollbackKey: "session-a:rollback-a",
      }),
    ).toBe("close")
  })
})
