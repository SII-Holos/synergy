import { describe, expect, test } from "bun:test"
import { resolveLightLoopControlState } from "./light-loop-control"

describe("Light Loop submit control", () => {
  test("allows task editing while the session is idle", () => {
    expect(resolveLightLoopControlState({ active: true, working: false, reviewPending: false })).toEqual({
      mode: "editable",
      description: "Changes apply from the next model step.",
    })
  })

  test("keeps the task read-only while the session is running", () => {
    expect(resolveLightLoopControlState({ active: true, working: true, reviewPending: false }).mode).toBe("readOnly")
  })

  test("keeps the task read-only while completion review is pending", () => {
    const state = resolveLightLoopControlState({ active: true, working: false, reviewPending: true })

    expect(state.mode).toBe("readOnly")
    expect(state.description).toContain("Completion review")
  })
  test("keeps stale task details read-only after Light Loop exits", () => {
    expect(resolveLightLoopControlState({ active: false, working: false, reviewPending: false })).toEqual({
      mode: "readOnly",
      description: "Light Loop is no longer active. Close this dialog to continue.",
    })
  })
})
