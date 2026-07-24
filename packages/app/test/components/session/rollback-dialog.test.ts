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

  test("shows each rollback once", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-a",
        seenKey: "session-a:rollback-a",
      }),
    ).toBe("wait")

    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-b",
        seenKey: "session-a:rollback-a",
      }),
    ).toBe("show")
  })

  test("keeps a presented rollback closed after the session page is recreated", () => {
    const rollbackKey = "session-a:rollback-a"

    expect(
      rollbackDialogAction({
        rollbackKey,
        seenKey: rollbackKey,
      }),
    ).toBe("wait")
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
})
