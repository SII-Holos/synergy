import { describe, expect, test } from "bun:test"
import {
  emptyRollbackDialogPresentationState,
  reduceRollbackDialogPresentationState,
} from "../../src/context/rollback-dialog"

describe("rollback dialog presentation state", () => {
  test("remembers the rollback shown for a session outside the page lifecycle", () => {
    const state = reduceRollbackDialogPresentationState(emptyRollbackDialogPresentationState, {
      type: "presented",
      key: "session-a:rollback-a",
    })

    expect(state).toEqual({ seenKey: "session-a:rollback-a" })
  })

  test("replaces the remembered key for a new rollback and clears it with the session", () => {
    const first = reduceRollbackDialogPresentationState(emptyRollbackDialogPresentationState, {
      type: "presented",
      key: "session-a:rollback-a",
    })
    const second = reduceRollbackDialogPresentationState(first, {
      type: "presented",
      key: "session-a:rollback-b",
    })

    expect(second).toEqual({ seenKey: "session-a:rollback-b" })
    expect(reduceRollbackDialogPresentationState(second, { type: "session_removed" })).toEqual(
      emptyRollbackDialogPresentationState,
    )
  })
})
