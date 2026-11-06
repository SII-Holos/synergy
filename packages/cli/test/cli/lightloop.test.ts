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
    const result = isLightLoopFinished({ workflow: { kind: "lightloop", status: "running" } })

    expect(result.finished).toBe(false)
    expect(result.status).toBeUndefined()
    expect(result.replaced).toBe(false)
  })

  test("returns finished when the workflow enters a terminal status", () => {
    const result = isLightLoopFinished({ workflow: { kind: "lightloop", status: "iteration_exhausted" } })

    expect(result.finished).toBe(true)
    expect(result.status).toBe("iteration_exhausted")
    expect(result.replaced).toBe(false)
  })

  test("returns finished when the workflow is cleared after approval", () => {
    const result = isLightLoopFinished({ workflow: undefined })

    expect(result.finished).toBe(true)
    expect(result.status).toBeUndefined()
    expect(result.replaced).toBe(false)
  })

  test("uses the durable terminal record as the authoritative status after clearance", () => {
    const result = isLightLoopFinished({ workflow: undefined }, { status: "timed_out" })

    expect(result.finished).toBe(true)
    expect(result.status).toBe("timed_out")
    expect(result.replaced).toBe(false)
  })

  test("returns finished with replaced when another workflow replaces the Light Loop", () => {
    const result = isLightLoopFinished({ workflow: { kind: "plan" } })

    expect(result.finished).toBe(true)
    expect(result.status).toBeUndefined()
    expect(result.replaced).toBe(true)
  })
})
