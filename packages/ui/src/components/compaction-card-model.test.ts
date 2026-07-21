import { describe, expect, test } from "bun:test"

import { resolveCompactionCardPresentation, COMPACTION_CARD_DESC } from "./compaction-card-model"

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
      title: COMPACTION_CARD_DESC.runningTitle,
      description: COMPACTION_CARD_DESC.preparingDescription,
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
      title: COMPACTION_CARD_DESC.completeTitle,
      description: COMPACTION_CARD_DESC.summaryReadyDescription,
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
      title: COMPACTION_CARD_DESC.runningTitle,
      description: COMPACTION_CARD_DESC.preparingDescription,
      canExpand: false,
    })
  })
})
