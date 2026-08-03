import { describe, expect, test } from "bun:test"
import { isLightLoopFinished, isTerminalLightLoopStatus } from "../../src/cli/lightloop"

describe("isTerminalLightLoopStatus", () => {
  test("accepts every terminal workflow status", () => {
    for (const status of ["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"]) {
      expect(isTerminalLightLoopStatus(status)).toBe(true)
    }
  })

  test("rejects active workflow statuses", () => {
    for (const status of ["running", "reviewing", undefined]) {
      expect(isTerminalLightLoopStatus(status)).toBe(false)
    }
  })

  test("rejects malformed values", () => {
    expect(isTerminalLightLoopStatus("bogus")).toBe(false)
  })
})

describe("isLightLoopFinished", () => {
  test("returns not finished while the workflow is still running", () => {
    const result = isLightLoopFinished({ workflow: { kind: "lightloop", instructions: "x", status: "running" } })

    expect(result.finished).toBe(false)
    expect(result.status).toBeUndefined()
  })

  test("returns finished when the workflow enters a terminal status", () => {
    const result = isLightLoopFinished({
      workflow: { kind: "lightloop", instructions: "x", status: "iteration_exhausted" },
    })

    expect(result.finished).toBe(true)
    expect(result.status).toBe("iteration_exhausted")
  })

  test("returns finished when the workflow is cleared after approval", () => {
    const result = isLightLoopFinished({ workflow: undefined })

    expect(result.finished).toBe(true)
    expect(result.status).toBeUndefined()
  })

  test("returns not finished when the session carries an unrelated workflow", () => {
    const result = isLightLoopFinished({ workflow: { kind: "plan" } })

    expect(result.finished).toBe(false)
  })
})
