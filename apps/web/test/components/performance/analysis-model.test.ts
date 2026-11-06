import { describe, expect, test } from "bun:test"
import {
  isPerformanceAnalysisActive,
  performanceAnalysisSessionPath,
  performanceAnalysisStatusDescriptor,
} from "../../../src/components/performance/analysis-model"
import { P } from "../../../src/components/performance/performance-i18n"

describe("performance analysis state", () => {
  test("only polls queued and running analyses", () => {
    expect(isPerformanceAnalysisActive("queued")).toBe(true)
    expect(isPerformanceAnalysisActive("running")).toBe(true)
    expect(isPerformanceAnalysisActive("completed")).toBe(false)
    expect(isPerformanceAnalysisActive("error")).toBe(false)
    expect(isPerformanceAnalysisActive("cancelled")).toBe(false)
    expect(isPerformanceAnalysisActive("interrupted")).toBe(false)
  })

  test("presents every durable analysis status", () => {
    expect(performanceAnalysisStatusDescriptor("queued")).toBe(P.analysisStatusQueued)
    expect(performanceAnalysisStatusDescriptor("running")).toBe(P.analysisStatusRunning)
    expect(performanceAnalysisStatusDescriptor("completed")).toBe(P.analysisStatusCompleted)
    expect(performanceAnalysisStatusDescriptor("error")).toBe(P.analysisStatusFailed)
    expect(performanceAnalysisStatusDescriptor("cancelled")).toBe(P.analysisStatusCancelled)
    expect(performanceAnalysisStatusDescriptor("interrupted")).toBe(P.analysisStatusInterrupted)
  })

  test("routes durable analysis sessions from the global Performance panel", () => {
    expect(
      performanceAnalysisSessionPath({
        sessionID: "ses_home",
        scope: { id: "home" },
      }),
    ).toBe("/aG9tZQ/session/ses_home")
    expect(
      performanceAnalysisSessionPath({
        sessionID: "ses_project",
        scope: { id: "project" },
      }),
    ).toBe("/cHJvamVjdA/session/ses_project")
    expect(
      performanceAnalysisSessionPath({
        sessionID: "ses_missing",
        scope: { id: "" },
      }),
    ).toBeUndefined()
  })
})
