import { describe, expect, test } from "bun:test"

import { resolveCompactionCardPresentation } from "./compaction-card-model"

describe("compaction card presentation", () => {
  test("keeps a pending compaction in the running state", () => {
    expect(
      resolveCompactionCardPresentation({
        hasRecovery: false,
        messageCompleted: false,
        hasSummary: false,
      }),
    ).toEqual({
      status: "running",
      title: "Compressing context...",
      description: "Preparing a compact continuation summary",
      canExpand: false,
    })
  })

  test("completes a mechanical fallback without treating validation as lifecycle state", () => {
    expect(
      resolveCompactionCardPresentation({
        hasRecovery: true,
        messageCompleted: true,
        hasSummary: true,
      }),
    ).toEqual({
      status: "complete",
      title: "Context compressed",
      description: "Summary ready",
      canExpand: true,
    })
  })

  test("waits for the terminal message update after recovery arrives", () => {
    expect(
      resolveCompactionCardPresentation({
        hasRecovery: true,
        messageCompleted: false,
        hasSummary: true,
      }),
    ).toEqual({
      status: "running",
      title: "Compressing context...",
      description: "Preparing a compact continuation summary",
      canExpand: false,
    })
  })
})
