import { describe, expect, test } from "bun:test"
import {
  deriveClarusTaskComposerState,
  type ClarusTaskComposerState,
  type ClarusTaskStatus,
  type ClarusTaskResultState,
  type ClarusTaskBindingSnapshot,
} from "./use-clarus-task-meta"

// =============================================================================
// Helper factories
// =============================================================================

function taskEndpoint(args: { agentId?: string; projectId?: string; taskId?: string } = {}) {
  return {
    kind: "clarus" as const,
    role: "task" as const,
    agentId: args.agentId ?? "agent_abc",
    projectId: args.projectId ?? "proj_def",
    taskId: args.taskId ?? "task_001",
  }
}

function projectEndpoint(args: { agentId?: string; projectId?: string } = {}) {
  return {
    kind: "clarus" as const,
    role: "project" as const,
    agentId: args.agentId ?? "agent_abc",
    projectId: args.projectId ?? "proj_def",
  }
}

function binding(opts: Partial<ClarusTaskBindingSnapshot> = {}): ClarusTaskBindingSnapshot {
  return {
    status: opts.status ?? "waiting",
    resultState: opts.resultState ?? "idle",
    title: opts.title ?? "Add dark mode support",
    phase: opts.phase ?? "implementation",
    attempt: opts.attempt ?? 0,
    ...opts,
  }
}

// =============================================================================
// Session recognition
// =============================================================================

describe("deriveClarusTaskComposerState — session recognition", () => {
  test("recognizes Clarus task endpoint with taskId", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding())
    expect(state.isClarusTask).toBe(true)
  })

  test("does not recognize Clarus project endpoint (no taskId) as a task", () => {
    const state = deriveClarusTaskComposerState(projectEndpoint(), undefined)
    expect(state.isClarusTask).toBe(false)
  })

  test("does not recognize undefined endpoint as a Clarus task", () => {
    const state = deriveClarusTaskComposerState(undefined, binding())
    expect(state.isClarusTask).toBe(false)
  })

  test("does not recognize channel endpoint as a Clarus task", () => {
    const state = deriveClarusTaskComposerState(
      { kind: "channel", channel: { type: "test", chatId: "ch-test" } },
      binding(),
    )
    expect(state.isClarusTask).toBe(false)
  })

  test("does not alter ordinary session recognition when endpoint is absent", () => {
    const state = deriveClarusTaskComposerState(undefined, undefined)
    expect(state.isClarusTask).toBe(false)
    expect(state.isReadOnly).toBe(false)
    expect(state.isInputEnabled).toBe(true)
  })
})

// =============================================================================
// Pre-result states: local guidance enabled
// =============================================================================

describe("deriveClarusTaskComposerState — pre-result states", () => {
  test("waiting: local guidance enabled, can submit", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "waiting" }))
    expect(state.isInputEnabled).toBe(true)
    expect(state.inputPlaceholder).toBe("Local guidance for this Clarus task")
    expect(state.headerStatusLabel).toBe("Waiting for assignment")
    expect(state.canSubmitResult).toBe(true)
    expect(state.isReadOnly).toBe(false)
  })

  test("running: local guidance enabled, can submit", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "running" }))
    expect(state.isInputEnabled).toBe(true)
    expect(state.inputPlaceholder).toBe("Local guidance for this Clarus task")
    expect(state.headerStatusLabel).toBe("Running")
    expect(state.canSubmitResult).toBe(true)
  })

  test("needs_attention (idle): local guidance enabled, can submit", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "idle" }),
    )
    expect(state.isInputEnabled).toBe(true)
    expect(state.inputPlaceholder).toBe("Local guidance for this Clarus task")
    expect(state.headerStatusLabel).toBe("Needs attention")
    expect(state.canSubmitResult).toBe(true)
  })
})

// =============================================================================
// Submitting / dispatched: disabled, draft preserved
// =============================================================================

describe("deriveClarusTaskComposerState — submitting and dispatched", () => {
  test("submitting: disabled with progress label, not read-only", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitting", resultState: "prepared" }),
    )
    expect(state.isInputEnabled).toBe(false)
    expect(state.inputPlaceholder).toBe("Submitting result to Clarus…")
    expect(state.headerStatusLabel).toBe("Submitting result to Clarus…")
    expect(state.canSubmitResult).toBe(false)
    expect(state.isReadOnly).toBe(false)
  })

  test("dispatched during running: disabled with progress", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "running", resultState: "dispatched" }),
    )
    expect(state.isInputEnabled).toBe(false)
    expect(state.inputPlaceholder).toBe("Submitting result to Clarus…")
    expect(state.headerStatusLabel).toBe("Submitting result to Clarus…")
    expect(state.canSubmitResult).toBe(false)
  })

  test("submitting/dispatched preserves draft — disabled but not read-only", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "submitting" }))
    expect(state.isInputEnabled).toBe(false)
    expect(state.isReadOnly).toBe(false)
  })

  test("prepared result state with running task status: disabled", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "running", resultState: "prepared" }))
    expect(state.isInputEnabled).toBe(false)
    expect(state.inputPlaceholder).toBe("Submitting result to Clarus…")
    expect(state.headerStatusLabel).toBe("Submitting result to Clarus…")
    expect(state.canSubmitResult).toBe(false)
  })
})

// =============================================================================
// Submitted / acknowledged: read-only, Continue locally available
// =============================================================================

describe("deriveClarusTaskComposerState — submitted", () => {
  test("submitted (acknowledged): read-only with Continue locally", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitted", resultState: "acknowledged" }),
    )
    expect(state.isReadOnly).toBe(true)
    expect(state.isInputEnabled).toBe(false)
    expect(state.inputPlaceholder).toBe("Submitted to Clarus")
    expect(state.headerStatusLabel).toBe("Submitted to Clarus")
    expect(state.headerResultLabel).toBe("Result acknowledged")
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(true)
    expect(state.isContinueLocallyPermanent).toBe(false)
  })

  test("submitted with acknowledged label", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitted", resultState: "acknowledged" }),
    )
    expect(state.headerResultLabel).toBe("Result acknowledged")
  })

  test("submitted without ack shows generic submitted label", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "submitted", resultState: "idle" }))
    expect(state.headerResultLabel).toBe("Result submitted")
  })
})

// =============================================================================
// Ambiguous: terminal read-only, no resubmit, no Continue locally
// =============================================================================

describe("deriveClarusTaskComposerState — ambiguous", () => {
  test("ambiguous: read-only, no resubmit, no Continue locally", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "ambiguous" }),
    )
    expect(state.isReadOnly).toBe(true)
    expect(state.isInputEnabled).toBe(false)
    expect(state.inputPlaceholder).toBe("Submission status unknown; no automatic retry")
    expect(state.headerStatusLabel).toBe("Submission status unknown; no automatic retry")
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })

  test("ambiguous exposes neither result resubmit nor Continue locally", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "ambiguous" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })

  test("ambiguous overrides any running/waiting status", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "running", resultState: "ambiguous" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.isReadOnly).toBe(true)
    expect(state.headerStatusLabel).toBe("Submission status unknown; no automatic retry")
  })
})

// =============================================================================
// Rejected: terminal read-only, no resubmit, no Continue locally
// =============================================================================

describe("deriveClarusTaskComposerState — rejected (terminal)", () => {
  test("rejected: terminal read-only, no result resubmit", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "rejected" }),
    )
    expect(state.isReadOnly).toBe(true)
    expect(state.isInputEnabled).toBe(false)
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })

  test("rejected exposes neither result resubmit nor Continue locally", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "rejected" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })

  test("rejected does not imply editing feedback can send a second result", () => {
    // Even if the task is needs_attention, a rejected result is terminal —
    // there is no path to submit a second logical result.
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "rejected" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.isInputEnabled).toBe(false)
  })
})

// =============================================================================
// local_only: local guidance, persistent local-only label, result-ineligible
// =============================================================================

describe("deriveClarusTaskComposerState — local_only", () => {
  test("local_only: input enabled with persistent local-only label", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "local_only" }),
    )
    expect(state.isInputEnabled).toBe(true)
    expect(state.inputPlaceholder).toBe("Local guidance for this Clarus task")
    expect(state.headerStatusLabel).toBe("Local only")
    expect(state.headerResultLabel).toBe("Result not eligible")
    expect(state.canSubmitResult).toBe(false)
    expect(state.isReadOnly).toBe(false)
  })

  test("local_only is permanently result-ineligible", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "running", resultState: "local_only" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.headerResultLabel).toBe("Result not eligible")
  })
})

// =============================================================================
// Continue locally: only from submitted/acknowledged, explicit, irreversible
// =============================================================================

describe("deriveClarusTaskComposerState — Continue locally", () => {
  test("Continue locally from submitted is explicit and irreversible", () => {
    const after = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({
        status: "submitted",
        resultState: "acknowledged",
        localContinuationEnabledAt: Date.now(),
      }),
    )
    expect(after.isContinueLocallyPermanent).toBe(true)
    expect(after.canContinueLocally).toBe(true)
    expect(after.canSubmitResult).toBe(false)
    expect(after.headerResultLabel).toBe("Result not eligible")
    expect(after.headerStatusLabel).toBe("Local continuation")
    expect(after.isInputEnabled).toBe(true)
    expect(after.inputPlaceholder).toBe("Continue working locally…")
    expect(after.isReadOnly).toBe(false)
  })

  test("Continue locally permanently removes result eligibility", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({
        status: "submitted",
        resultState: "acknowledged",
        localContinuationEnabledAt: 1,
      }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.isContinueLocallyPermanent).toBe(true)
    expect(state.headerResultLabel).toBe("Result not eligible")
  })

  test("Continue locally is only available from submitted/acknowledged", () => {
    // ambiguous: no Continue locally
    const amb = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "ambiguous" }),
    )
    expect(amb.canContinueLocally).toBe(false)

    // rejected: no Continue locally
    const rej = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "rejected" }),
    )
    expect(rej.canContinueLocally).toBe(false)
  })
})

// =============================================================================
// Terminal states: read-only
// =============================================================================

describe("deriveClarusTaskComposerState — terminal states", () => {
  test("expired: read-only", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "expired" }))
    expect(state.isReadOnly).toBe(true)
    expect(state.isInputEnabled).toBe(false)
    expect(state.inputPlaceholder).toBe("Task expired")
    expect(state.canSubmitResult).toBe(false)
  })

  test("cancelled: read-only", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "cancelled" }))
    expect(state.isReadOnly).toBe(true)
    expect(state.isInputEnabled).toBe(false)
    expect(state.inputPlaceholder).toBe("Task cancelled")
    expect(state.canSubmitResult).toBe(false)
  })

  test("failed: read-only", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "failed" }))
    expect(state.isReadOnly).toBe(true)
    expect(state.isInputEnabled).toBe(false)
    expect(state.canSubmitResult).toBe(false)
  })
})

// =============================================================================
// No implicit or auto resubmit
// =============================================================================

describe("deriveClarusTaskComposerState — no implicit resubmit", () => {
  test("ambiguous: no auto or implicit resubmit", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "ambiguous" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.isInputEnabled).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })

  test("rejected: no auto resubmit, no Continue locally bypass", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "rejected" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })

  test("submitted: no auto resubmit", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitted", resultState: "acknowledged" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.isInputEnabled).toBe(false)
  })

  test("submitted must use explicit Continue locally — no second result", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitted", resultState: "acknowledged" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(true)
  })
})

// =============================================================================
// Draft preservation across transitions
// =============================================================================

describe("deriveClarusTaskComposerState — draft preservation", () => {
  test("submitting preserves draft — disabled but not read-only", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitting", resultState: "prepared" }),
    )
    expect(state.isInputEnabled).toBe(false)
    expect(state.isReadOnly).toBe(false)
  })

  test("local guidance states preserve draft", () => {
    for (const s of ["waiting", "running"] as ClarusTaskStatus[]) {
      const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: s }))
      expect(state.isInputEnabled).toBe(true)
      expect(state.isReadOnly).toBe(false)
    }
  })

  test("Continue locally preserves draft", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitted", localContinuationEnabledAt: Date.now() }),
    )
    expect(state.isInputEnabled).toBe(true)
    expect(state.isReadOnly).toBe(false)
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
      const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status, resultState: result }))
      expect(state.isReadOnly).toBe(true)
    }
  })
})

// =============================================================================
// No second result semantics
// =============================================================================

describe("deriveClarusTaskComposerState — no second result", () => {
  test("submitted: cannot submit a second result", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitted", resultState: "acknowledged" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(true)
  })

  test("local continuation: permanently result-ineligible", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "submitted", localContinuationEnabledAt: 1 }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.isContinueLocallyPermanent).toBe(true)
    expect(state.headerResultLabel).toBe("Result not eligible")
  })

  test("local_only: permanently result-ineligible", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "local_only" }),
    )
    expect(state.canSubmitResult).toBe(false)
  })

  test("rejected: no second-result path", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "rejected" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })

  test("ambiguous: no second-result path", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "needs_attention", resultState: "ambiguous" }),
    )
    expect(state.canSubmitResult).toBe(false)
    expect(state.canContinueLocally).toBe(false)
  })
})

// =============================================================================
// Result-state validation: invalid "submitting" result state mapped to idle
// =============================================================================

describe("deriveClarusTaskComposerState — result-state validation", () => {
  test("invalid result-state string 'submitting' is mapped to idle (not a valid result state)", () => {
    const state = deriveClarusTaskComposerState(
      taskEndpoint(),
      binding({ status: "waiting", resultState: "submitting" as ClarusTaskResultState }),
    )
    expect(state.isInputEnabled).toBe(true)
    expect(state.canSubmitResult).toBe(true)
    expect(state.headerStatusLabel).toBe("Waiting for assignment")
  })

  test("valid result-state 'prepared' is recognized, not mapped to idle", () => {
    const state = deriveClarusTaskComposerState(taskEndpoint(), binding({ status: "waiting", resultState: "prepared" }))
    expect(state.isInputEnabled).toBe(false)
    expect(state.canSubmitResult).toBe(false)
  })
})
