import { describe, expect, test } from "bun:test"

import { resolveCompactionCardPresentation, COMPACTION_CARD_DESC } from "../../src/components/compaction-card-model"

describe("compaction card presentation", () => {
  test("keeps a pending compaction in the running state", () => {
    expect(
      resolveCompactionCardPresentation({
        attemptState: "running",
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
        attemptState: "committed",
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
        attemptState: "committed",
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
  test("presents a failed compaction with the provider error and expandable details", () => {
    expect(
      resolveCompactionCardPresentation({
        attemptState: "failed",
        error: "error: Insufficient balance for this request.\nrequest_id: req_123",
        hasRecovery: false,
        messageCompleted: true,
        hasSummary: false,
      }),
    ).toEqual({
      status: "failed",
      title: COMPACTION_CARD_DESC.failedTitle,
      description: "Insufficient balance for this request.",
      error: "error: Insufficient balance for this request.\nrequest_id: req_123",
      canExpand: true,
    })
  })

  test("uses localized recovery copy when a failed attempt has no persisted diagnostic", () => {
    expect(
      resolveCompactionCardPresentation({
        attemptState: "failed",
        hasRecovery: false,
        messageCompleted: true,
        hasSummary: false,
      }),
    ).toEqual({
      status: "failed",
      title: COMPACTION_CARD_DESC.failedTitle,
      description: COMPACTION_CARD_DESC.failedDescription,
      error: undefined,
      canExpand: false,
    })
  })
})
