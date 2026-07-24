import { describe, expect, test } from "bun:test"
import {
  isActiveLightLoopWorkflow,
  resolveLightLoopControlState,
} from "../../../src/components/prompt-input/light-loop-control"

describe("Light Loop submit control", () => {
  test("treats retained terminal workflow records as inactive", () => {
    for (const status of ["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"]) {
      expect(isActiveLightLoopWorkflow({ kind: "lightloop", status })).toBe(false)
    }
    expect(isActiveLightLoopWorkflow({ kind: "lightloop", status: "running" })).toBe(true)
    expect(isActiveLightLoopWorkflow({ kind: "lightloop" })).toBe(true)
    expect(isActiveLightLoopWorkflow({ kind: "plan" })).toBe(false)
    expect(isActiveLightLoopWorkflow(undefined)).toBe(false)
  })

  test("allows task editing while the session is idle", () => {
    expect(resolveLightLoopControlState({ active: true, working: false, reviewPending: false })).toEqual({
      mode: "editable",
      reason: "editable",
    })
  })

  test("keeps the task read-only while the session is running", () => {
    expect(resolveLightLoopControlState({ active: true, working: true, reviewPending: false })).toEqual({
      mode: "readOnly",
      reason: "working",
    })
  })

  test("keeps the task read-only while completion review is pending", () => {
    expect(resolveLightLoopControlState({ active: true, working: false, reviewPending: true })).toEqual({
      mode: "readOnly",
      reason: "reviewPending",
    })
  })

  test("keeps stale task details read-only after Light Loop exits", () => {
    expect(resolveLightLoopControlState({ active: false, working: false, reviewPending: false })).toEqual({
      mode: "readOnly",
      reason: "inactive",
    })
  })
})
