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

  test("shows each rollback once and keeps a dismissed rollback closed", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-a",
        presentedKey: "session-a:rollback-a",
      }),
    ).toBe("wait")

    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-a",
        dismissedKey: "session-a:rollback-a",
      }),
    ).toBe("wait")

    expect(
      rollbackDialogAction({
        rollbackKey: "session-a:rollback-b",
        presentedKey: "session-a:rollback-a",
        dismissedKey: "session-a:rollback-a",
      }),
    ).toBe("show")
  })

  test("closes an obsolete rollback dialog before presenting newer state", () => {
    expect(
      rollbackDialogAction({
        rollbackKey: undefined,
        activeDialogID: "rollback-dialog",
        rollbackDialogID: "rollback-dialog",
        presentedKey: "session-a:rollback-a",
      }),
    ).toBe("close")

    expect(
      rollbackDialogAction({
        rollbackKey: "session-b:rollback-b",
        activeDialogID: "rollback-dialog",
        rollbackDialogID: "rollback-dialog",
        presentedKey: "session-a:rollback-a",
      }),
    ).toBe("close")
  })
})
