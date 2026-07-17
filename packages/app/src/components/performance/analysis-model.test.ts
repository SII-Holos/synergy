import { describe, expect, test } from "bun:test"
import { isPerformanceAnalysisActive, performanceAnalysisStatusLabel } from "./analysis-model"

describe("performance analysis state", () => {
  test("only polls queued and running analyses", () => {
    expect(isPerformanceAnalysisActive("queued")).toBe(true)
    expect(isPerformanceAnalysisActive("running")).toBe(true)
    expect(isPerformanceAnalysisActive("completed")).toBe(false)
    expect(isPerformanceAnalysisActive("error")).toBe(false)
    expect(isPerformanceAnalysisActive("cancelled")).toBe(false)
    expect(isPerformanceAnalysisActive("interrupted")).toBe(false)
  })

  test("presents every durable Cortex status", () => {
    expect(performanceAnalysisStatusLabel("queued")).toBe("Queued")
    expect(performanceAnalysisStatusLabel("running")).toBe("Running")
    expect(performanceAnalysisStatusLabel("completed")).toBe("Completed")
    expect(performanceAnalysisStatusLabel("error")).toBe("Failed")
    expect(performanceAnalysisStatusLabel("cancelled")).toBe("Cancelled")
    expect(performanceAnalysisStatusLabel("interrupted")).toBe("Interrupted")
  })
})
