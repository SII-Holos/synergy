import { describe, expect, test } from "bun:test"
import {
  ABANDON_HOLD_MS,
  canLongPressAbandon,
  resolvePromptControlState,
} from "../../../src/components/prompt-input/control-state"

describe("composer primary control", () => {
  test("keeps exactly one meaning per session state", () => {
    expect(resolvePromptControlState({ hasDraft: false, activity: "idle", hasArmedWorkflow: false })).toBe("disabled")
    expect(resolvePromptControlState({ hasDraft: false, activity: "working", hasArmedWorkflow: false })).toBe("pause")
    expect(resolvePromptControlState({ hasDraft: false, activity: "paused", hasArmedWorkflow: false })).toBe("continue")
    expect(resolvePromptControlState({ hasDraft: false, activity: "idle", hasArmedWorkflow: true })).toBe("send")
  })

  test("a draft always sends, so it never takes stop or continue away", () => {
    // The draft is the user's explicit intent, and sending is also how a paused
    // session resumes, so a draft must win over every session state.
    for (const activity of ["idle", "working", "waiting", "paused"] as const) {
      for (const hasArmedWorkflow of [false, true]) {
        expect(resolvePromptControlState({ hasDraft: true, activity, hasArmedWorkflow })).toBe("send")
      }
    }
  })

  test("never resolves a paused session to the stop control", () => {
    // The defect this replaced rendered a stop affordance for a session that was
    // already stopped, so no input may produce "pause" while paused.
    for (const hasDraft of [false, true]) {
      for (const hasArmedWorkflow of [false, true]) {
        expect(resolvePromptControlState({ hasDraft, activity: "paused", hasArmedWorkflow })).not.toBe("pause")
      }
    }
  })

  test("waiting for the user is not ordinary work", () => {
    // A pending permission or question is not progress, so the control must not
    // offer to stop work that is not running.
    expect(resolvePromptControlState({ hasDraft: false, activity: "waiting", hasArmedWorkflow: false })).toBe(
      "disabled",
    )
  })
})

describe("long-press abandon", () => {
  test("arms whenever there is something to abandon", () => {
    expect(canLongPressAbandon({ hasDraft: true, activity: "idle", hasBoundWorkflow: false })).toBe(false)
    expect(canLongPressAbandon({ hasDraft: false, activity: "working", hasBoundWorkflow: false })).toBe(true)
    expect(canLongPressAbandon({ hasDraft: false, activity: "paused", hasBoundWorkflow: false })).toBe(true)
    expect(canLongPressAbandon({ hasDraft: false, activity: "idle", hasBoundWorkflow: true })).toBe(true)
  })

  test("does not arm on an idle composer with nothing bound", () => {
    // There is no action to confirm and no workflow to cancel, so a hold would
    // only risk an accidental destructive gesture.
    expect(canLongPressAbandon({ hasDraft: false, activity: "idle", hasBoundWorkflow: false })).toBe(false)
    expect(canLongPressAbandon({ hasDraft: false, activity: "waiting", hasBoundWorkflow: false })).toBe(false)
  })

  test("holds long enough to survive an accidental press", () => {
    // The ring is the only confirmation, so the threshold is the whole
    // mis-fire protection for a destructive, unconfirmed gesture.
    expect(ABANDON_HOLD_MS).toBeGreaterThanOrEqual(3000)
  })
})
