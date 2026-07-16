import { describe, expect, test } from "bun:test"
import {
  composeTaskLifecycle,
  type ComposerLifecycleState,
  type ComposerLifecycleInput,
  type ClarusTaskStatus,
  type ClarusTaskResultState,
} from "./task-composer-lifecycle"

// =============================================================================
// Helper
// =============================================================================

function st(data: Partial<ComposerLifecycleInput> = {}): ComposerLifecycleInput {
  return {
    taskStatus: data.taskStatus ?? "waiting",
    resultState: data.resultState ?? "idle",
    localContinuationEnabled: data.localContinuationEnabled ?? false,
  }
}

// =============================================================================
// Pre-result states: local guidance enabled
// =============================================================================

describe("composer lifecycle — pre-result states", () => {
  test("waiting: input enabled, can submit, local guidance placeholder", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "waiting" }))
    expect(s.isInputEnabled).toBe(true)
    expect(s.canSubmitResult).toBe(true)
    expect(s.inputPlaceholder).toBe("Local guidance for this Clarus task")
    expect(s.headerStatusLabel).toBe("Waiting for assignment")
    expect(s.isReadOnly).toBe(false)
  })

  test("running: input enabled, can submit", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "running" }))
    expect(s.isInputEnabled).toBe(true)
    expect(s.inputPlaceholder).toBe("Local guidance for this Clarus task")
    expect(s.canSubmitResult).toBe(true)
    expect(s.headerStatusLabel).toBe("Running")
  })

  test("needs_attention (idle): input enabled, can submit", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "idle" }))
    expect(s.isInputEnabled).toBe(true)
    expect(s.canSubmitResult).toBe(true)
    expect(s.inputPlaceholder).toBe("Local guidance for this Clarus task")
  })
})

// =============================================================================
// Submitting / dispatched: disabled, draft preserved
// =============================================================================

describe("composer lifecycle — submitting and dispatched", () => {
  test("submitting: disabled, progress label, not read-only", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "submitting", resultState: "prepared" }))
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Submitting result to Clarus…")
    expect(s.headerStatusLabel).toBe("Submitting result to Clarus…")
    expect(s.isReadOnly).toBe(false)
    expect(s.canSubmitResult).toBe(false)
  })

  test("dispatched during running: disabled with progress", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "running", resultState: "dispatched" }))
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Submitting result to Clarus…")
    expect(s.headerStatusLabel).toBe("Submitting result to Clarus…")
    expect(s.canSubmitResult).toBe(false)
  })

  test("dispatched during needs_attention: disabled with progress", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "dispatched" }))
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Submitting result to Clarus…")
  })

  test("prepared is recognized as a submitting/dispatched result state", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "running", resultState: "prepared" }))
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Submitting result to Clarus…")
    expect(s.headerStatusLabel).toBe("Submitting result to Clarus…")
    expect(s.canSubmitResult).toBe(false)
    expect(s.isReadOnly).toBe(false)
  })
})

// =============================================================================
// Submitted / acknowledged: read-only, Continue locally available
// =============================================================================

describe("composer lifecycle — submitted and acknowledged", () => {
  test("submitted (acknowledged): read-only, Continue locally available", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "submitted", resultState: "acknowledged" }))
    expect(s.isReadOnly).toBe(true)
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Submitted to Clarus")
    expect(s.headerStatusLabel).toBe("Submitted to Clarus")
    expect(s.headerResultLabel).toBe("Result acknowledged")
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(true)
  })

  test("submitted (non-acknowledged): read-only, Continue locally, generic label", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "submitted", resultState: "idle" }))
    expect(s.headerResultLabel).toBe("Result submitted")
    expect(s.canContinueLocally).toBe(true)
  })
})

// =============================================================================
// Ambiguous: terminal read-only, no resubmit, no Continue locally
// =============================================================================

describe("composer lifecycle — ambiguous (terminal)", () => {
  test("ambiguous: read-only, no resubmit, no Continue locally", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "ambiguous" }))
    expect(s.isReadOnly).toBe(true)
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Submission status unknown; no automatic retry")
    expect(s.headerStatusLabel).toBe("Submission status unknown; no automatic retry")
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })

  test("ambiguous: exposes neither result resubmit nor Continue locally", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "ambiguous" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })

  test("ambiguous overrides running/waiting status", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "running", resultState: "ambiguous" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.isReadOnly).toBe(true)
  })
})

// =============================================================================
// Rejected: terminal read-only, no resubmit, no Continue locally
// =============================================================================

describe("composer lifecycle — rejected (terminal)", () => {
  test("rejected: terminal read-only, no result resubmit", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "rejected" }))
    expect(s.isReadOnly).toBe(true)
    expect(s.isInputEnabled).toBe(false)
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })

  test("rejected: exposes neither result resubmit nor Continue locally", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "rejected" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })

  test("rejected does not imply editing feedback can send a second result", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "rejected" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.isInputEnabled).toBe(false)
  })
})

// =============================================================================
// local_only: local guidance, persistent local-only, result-ineligible
// =============================================================================

describe("composer lifecycle — local_only", () => {
  test("local_only: input enabled with persistent local-only label", () => {
    const s = composeTaskLifecycle(st({ resultState: "local_only" }))
    expect(s.isInputEnabled).toBe(true)
    expect(s.inputPlaceholder).toBe("Local guidance for this Clarus task")
    expect(s.headerStatusLabel).toBe("Local only")
    expect(s.headerResultLabel).toBe("Result not eligible")
    expect(s.canSubmitResult).toBe(false)
    expect(s.isReadOnly).toBe(false)
  })

  test("local_only is permanently result-ineligible", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "running", resultState: "local_only" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.headerResultLabel).toBe("Result not eligible")
  })
})

// =============================================================================
// Continue locally: only from submitted/acknowledged, explicit, irreversible
// =============================================================================

describe("composer lifecycle — Continue locally", () => {
  test("Continue locally from submitted is explicit and irreversible", () => {
    const s = composeTaskLifecycle(
      st({
        taskStatus: "submitted",
        resultState: "acknowledged",
        localContinuationEnabled: true,
      }),
    )
    expect(s.isContinueLocallyPermanent).toBe(true)
    expect(s.canContinueLocally).toBe(true)
    expect(s.canSubmitResult).toBe(false)
    expect(s.headerResultLabel).toBe("Result not eligible")
    expect(s.headerStatusLabel).toBe("Local continuation")
    expect(s.isInputEnabled).toBe(true)
    expect(s.inputPlaceholder).toBe("Continue working locally…")
    expect(s.isReadOnly).toBe(false)
  })

  test("Continue locally permanently removes result eligibility", () => {
    const s = composeTaskLifecycle(
      st({
        taskStatus: "submitted",
        resultState: "acknowledged",
        localContinuationEnabled: true,
      }),
    )
    expect(s.canSubmitResult).toBe(false)
    expect(s.isContinueLocallyPermanent).toBe(true)
  })

  test("Continue locally is only available from submitted/acknowledged", () => {
    // ambiguous → no Continue locally
    const amb = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "ambiguous" }))
    expect(amb.canContinueLocally).toBe(false)

    // rejected → no Continue locally
    const rej = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "rejected" }))
    expect(rej.canContinueLocally).toBe(false)
  })
})

// =============================================================================
// Terminal states: read-only
// =============================================================================

describe("composer lifecycle — terminal states", () => {
  test("expired: read-only, no Continue locally", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "expired" }))
    expect(s.isReadOnly).toBe(true)
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Task expired")
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })

  test("cancelled: read-only", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "cancelled" }))
    expect(s.isReadOnly).toBe(true)
    expect(s.isInputEnabled).toBe(false)
    expect(s.inputPlaceholder).toBe("Task cancelled")
  })

  test("failed: read-only", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "failed" }))
    expect(s.isReadOnly).toBe(true)
    expect(s.isInputEnabled).toBe(false)
  })
})

// =============================================================================
// No implicit or auto resubmit
// =============================================================================

describe("composer lifecycle — no implicit resubmit", () => {
  test("ambiguous: no auto-resubmit", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "ambiguous" }))
    expect(s.canSubmitResult).toBe(false)
  })

  test("rejected: no auto-resubmit, no Continue locally bypass", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "rejected" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })

  test("submitted: no auto-resubmit", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "submitted", resultState: "acknowledged" }))
    expect(s.canSubmitResult).toBe(false)
  })

  test("terminal states do not resubmit", () => {
    for (const status of ["failed", "expired", "cancelled"] as ClarusTaskStatus[]) {
      const s = composeTaskLifecycle(st({ taskStatus: status }))
      expect(s.canSubmitResult).toBe(false)
    }
  })
})

// =============================================================================
// No second result — permanent semantics
// =============================================================================

describe("composer lifecycle — no second result", () => {
  test("submitted: cannot submit a second result", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "submitted", resultState: "acknowledged" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(true)
  })

  test("local continuation: permanently result-ineligible", () => {
    const s = composeTaskLifecycle(
      st({
        taskStatus: "submitted",
        resultState: "acknowledged",
        localContinuationEnabled: true,
      }),
    )
    expect(s.canSubmitResult).toBe(false)
    expect(s.isContinueLocallyPermanent).toBe(true)
  })

  test("local_only: permanently result-ineligible", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "local_only" }))
    expect(s.canSubmitResult).toBe(false)
  })

  test("rejected: no second-result path", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "rejected" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })

  test("ambiguous: no second-result path", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "needs_attention", resultState: "ambiguous" }))
    expect(s.canSubmitResult).toBe(false)
    expect(s.canContinueLocally).toBe(false)
  })
})

// =============================================================================
// Draft preservation across transitions
// =============================================================================

describe("composer lifecycle — draft preservation", () => {
  test("submitting preserves draft — disabled but not read-only", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "submitting", resultState: "prepared" }))
    expect(s.isInputEnabled).toBe(false)
    expect(s.isReadOnly).toBe(false)
  })

  test("dispatched preserves draft — disabled but not read-only", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "running", resultState: "dispatched" }))
    expect(s.isInputEnabled).toBe(false)
    expect(s.isReadOnly).toBe(false)
  })

  test("local guidance states preserve draft", () => {
    for (const status of ["waiting", "running"] as ClarusTaskStatus[]) {
      const s = composeTaskLifecycle(st({ taskStatus: status }))
      expect(s.isInputEnabled).toBe(true)
      expect(s.isReadOnly).toBe(false)
    }
  })

  test("Continue locally preserves draft", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "submitted", localContinuationEnabled: true }))
    expect(s.isInputEnabled).toBe(true)
    expect(s.isReadOnly).toBe(false)
  })

  test("read-only states are truly read-only", () => {
    const readOnlyCases: Array<[ClarusTaskStatus, ClarusTaskResultState]> = [
      ["submitted", "acknowledged"],
      ["submitted", "idle"],
      ["needs_attention", "ambiguous"],
      ["needs_attention", "rejected"],
      ["expired", "idle"],
      ["cancelled", "idle"],
      ["failed", "idle"],
    ]
    for (const [status, result] of readOnlyCases) {
      const s = composeTaskLifecycle(st({ taskStatus: status, resultState: result }))
      expect(s.isReadOnly).toBe(true)
    }
  })
})

// =============================================================================
// Local guidance routes through session input, not Clarus outbound composer
// =============================================================================

describe("composer lifecycle — input routing invariant", () => {
  test("local guidance states use the session input path", () => {
    const localGuidanceStates: ComposerLifecycleInput[] = [
      st({ taskStatus: "waiting" }),
      st({ taskStatus: "running" }),
      st({ taskStatus: "needs_attention", resultState: "idle" }),
      st({ resultState: "local_only" }),
      st({
        taskStatus: "submitted",
        resultState: "acknowledged",
        localContinuationEnabled: true,
      }),
    ]

    for (const input of localGuidanceStates) {
      const s = composeTaskLifecycle(input)
      expect(s.isInputEnabled).toBe(true)
      expect(s.inputPlaceholder).not.toContain("global.clarus.composer")
      expect(s.inputPlaceholder).not.toContain("sendProjectMessage")
      expect(s.inputPlaceholder).not.toContain("Submit to project")
    }
  })

  test("disabled/read-only states show progress/terminal labels, not composer routing", () => {
    const disabledStates: ComposerLifecycleInput[] = [
      st({ taskStatus: "submitting" }),
      st({
        taskStatus: "submitted",
        resultState: "acknowledged",
      }),
      st({ taskStatus: "needs_attention", resultState: "ambiguous" }),
      st({ taskStatus: "needs_attention", resultState: "rejected" }),
      st({ taskStatus: "expired" }),
      st({ taskStatus: "cancelled" }),
      st({ taskStatus: "failed" }),
    ]

    for (const input of disabledStates) {
      const s = composeTaskLifecycle(input)
      expect(s.inputPlaceholder).not.toContain("composer")
      expect(s.inputPlaceholder).not.toContain("sendProjectMessage")
    }
  })
})

// =============================================================================
// Result-state contract: "submitting" is a task status, not a result state
// =============================================================================

describe("composer lifecycle — result-state contract", () => {
  test("prepared is a valid result state, not mapped to idle", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "waiting", resultState: "prepared" }))
    expect(s.isInputEnabled).toBe(false)
    expect(s.canSubmitResult).toBe(false)
  })

  test("idle result state allows submission in pre-result task states", () => {
    const s = composeTaskLifecycle(st({ taskStatus: "waiting", resultState: "idle" }))
    expect(s.isInputEnabled).toBe(true)
    expect(s.canSubmitResult).toBe(true)
  })
})
