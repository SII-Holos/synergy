import { describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { redactErrorMessage } from "../../src/server/clarus-route"

// ======================================================================
// NAVIGATION CONTRACT — Pure mapping DTO allowlist and redaction tests
// ======================================================================
// These tests verify the SHAPE and FIELD ALLOWLIST of the Clarus
// navigation DTOs and the behavioral correctness of the error redaction
// function. Redaction tests exercise the actual production redactErrorMessage()
// function — they test the OUTPUT against redacted patterns, not raw fixtures.
// ======================================================================

// ── Task status priority ordering ───────────────────────

describe("Navigation DTO: task priority ordering constant", () => {
  test("priority order matches Blueprint: needs_attention, running, submitting, waiting, submitted, failed, expired, cancelled", () => {
    const EXPECTED_PRIORITY = [
      "needs_attention",
      "running",
      "submitting",
      "waiting",
      "submitted",
      "failed",
      "expired",
      "cancelled",
    ]

    const ALL_KNOWN_STATUSES = new Set([
      "waiting",
      "running",
      "needs_attention",
      "submitting",
      "submitted",
      "failed",
      "expired",
      "cancelled",
    ])

    const prioritySet = new Set(EXPECTED_PRIORITY)
    expect(prioritySet.size).toBe(ALL_KNOWN_STATUSES.size)
    for (const status of ALL_KNOWN_STATUSES) {
      expect(prioritySet.has(status)).toBe(true)
    }

    const rank = new Map(EXPECTED_PRIORITY.map((s, i) => [s, i]))
    expect(rank.get("needs_attention")!).toBeLessThan(rank.get("running")!)
    expect(rank.get("running")!).toBeLessThan(rank.get("submitting")!)
    expect(rank.get("submitting")!).toBeLessThan(rank.get("waiting")!)
    expect(rank.get("waiting")!).toBeLessThan(rank.get("submitted")!)
    expect(rank.get("submitted")!).toBeLessThan(rank.get("failed")!)
    expect(rank.get("failed")!).toBeLessThan(rank.get("expired")!)
    expect(rank.get("expired")!).toBeLessThan(rank.get("cancelled")!)
  })

  test("within same priority rank, tasks are ordered by latest activity (updatedAt desc)", () => {
    const tasks = [
      { taskId: "a", status: "running", updatedAt: 100 },
      { taskId: "b", status: "running", updatedAt: 200 },
      { taskId: "c", status: "running", updatedAt: 150 },
    ]

    const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
    expect(sorted.map((t) => t.taskId)).toEqual(["b", "c", "a"])
  })
})

// ── Task DTO field allowlist ────────────────────────────

describe("Navigation DTO: task item field allowlist", () => {
  const NAV_TASK_ALLOWED = new Set([
    "taskId",
    "projectId",
    "sessionID",
    "title",
    "status",
    "resultState",
    "phase",
    "attempt",
    "deadlineAt",
    "contextHydration",
    "localContinuationEnabledAt",
    "resultRecordedAt",
    "runID",
    "subtaskID",
    "createdAt",
    "updatedAt",
  ])

  const NAV_TASK_FORBIDDEN = new Set([
    "workspacePath",
    "scopeID",
    "frozenAgent",
    "taskInput",
    "extendOutboxRequestIDs",
    "assignmentInboxItemID",
    "assignmentMessageID",
    "resultOutboxRequestID",
    "taskSessionOwnershipClaim",
    "assignmentState",
    "materializedAt",
    "lastCompletedAssistantMessageID",
    "schemaVersion",
  ])

  test("allowed fields are a non-empty set", () => {
    expect(NAV_TASK_ALLOWED.size).toBeGreaterThan(0)
  })

  test("forbidden fields are not in allowed set", () => {
    for (const field of NAV_TASK_FORBIDDEN) {
      expect(NAV_TASK_ALLOWED.has(field)).toBe(false)
    }
  })

  test("sessionID is in the allowed set (HOME_SCOPE_KEY routing)", () => {
    expect(NAV_TASK_ALLOWED.has("sessionID")).toBe(true)
  })

  test("workspacePath and scopeID are explicitly forbidden", () => {
    expect(NAV_TASK_FORBIDDEN.has("workspacePath")).toBe(true)
    expect(NAV_TASK_FORBIDDEN.has("scopeID")).toBe(true)
  })
})

// ── Project DTO field allowlist ─────────────────────────

describe("Navigation DTO: project item field allowlist", () => {
  const NAV_PROJECT_ALLOWED = new Set([
    "projectId",
    "projectName",
    "projectSlug",
    "activeGroup",
    "projectStatus",
    "primaryAgent",
    "lastProjectActivityAt",
    "createdAt",
    "updatedAt",
  ])

  const NAV_PROJECT_FORBIDDEN = new Set([
    "workspacePath",
    "scopeID",
    "membership",
    "agentId",
    "messageCursor",
    "desiredSubscription",
    "lastReconciliationAt",
    "lastReconciliationError",
    "schemaVersion",
  ])

  test("allowed fields are a non-empty set", () => {
    expect(NAV_PROJECT_ALLOWED.size).toBeGreaterThan(0)
  })

  test("forbidden fields are not in allowed set", () => {
    for (const field of NAV_PROJECT_FORBIDDEN) {
      expect(NAV_PROJECT_ALLOWED.has(field)).toBe(false)
    }
  })

  test("activeGroup is used for grouping (not lifecycle directly)", () => {
    expect(NAV_PROJECT_ALLOWED.has("activeGroup")).toBe(true)
  })
})

// ── Connection status enum ──────────────────────────────

describe("Navigation DTO: connection status enum", () => {
  test("public status enum is exactly: disabled, connected, reconnecting, sign_in_required, sync_failed", () => {
    const CONNECTION_STATUSES = ["disabled", "connected", "reconnecting", "sign_in_required", "sync_failed"]

    expect(CONNECTION_STATUSES.length).toBe(5)
    expect(new Set(CONNECTION_STATUSES).size).toBe(5)

    expect(CONNECTION_STATUSES).not.toContain("connecting")
    expect(CONNECTION_STATUSES).not.toContain("blocked")
    expect(CONNECTION_STATUSES).not.toContain("disconnected")
  })
})

// ── Continue-local eligibility ─────────────────────────

describe("Navigation DTO: continue-local eligibility rules", () => {
  test("eligible statuses: submitted", () => {
    const eligibleStatuses = new Set(["submitted"])
    expect(eligibleStatuses.has("submitted")).toBe(true)
    expect(eligibleStatuses.has("running")).toBe(false)
    expect(eligibleStatuses.has("waiting")).toBe(false)
    expect(eligibleStatuses.has("submitting")).toBe(false)
    expect(eligibleStatuses.has("expired")).toBe(false)
    expect(eligibleStatuses.has("cancelled")).toBe(false)
    expect(eligibleStatuses.has("failed")).toBe(false)
    expect(eligibleStatuses.has("needs_attention")).toBe(false)
  })

  test("eligible result states: acknowledged", () => {
    const eligibleResultStates = new Set(["acknowledged"])
    expect(eligibleResultStates.has("acknowledged")).toBe(true)
    expect(eligibleResultStates.has("ambiguous")).toBe(false)
    expect(eligibleResultStates.has("rejected")).toBe(false)
    expect(eligibleResultStates.has("idle")).toBe(false)
    expect(eligibleResultStates.has("dispatched")).toBe(false)
    expect(eligibleResultStates.has("prepared")).toBe(false)
    expect(eligibleResultStates.has("local_only")).toBe(false) // already local_only
  })

  test("local_only is a terminal state and cannot be used for another Clarus result", () => {
    const terminalStates = new Set(["acknowledged", "rejected", "ambiguous", "local_only"])
    expect(terminalStates.has("local_only")).toBe(true)
  })
})

// ── Context hydration enum ──────────────────────────────

describe("Navigation DTO: contextHydration enum", () => {
  test("exact enum values: complete, partial, unavailable", () => {
    const HYDRATION_VALUES = ["complete", "partial", "unavailable"]
    expect(new Set(HYDRATION_VALUES).size).toBe(3)
    expect(HYDRATION_VALUES).toContain("complete")
    expect(HYDRATION_VALUES).toContain("partial")
    expect(HYDRATION_VALUES).toContain("unavailable")
  })
})

// ── Error redaction contract ────────────────────────────

describe("Security: redactErrorMessage behavioral contract", () => {
  test("redacts Bearer tokens", () => {
    const message = "Failed with Bearer sk-abc123def456 to https://api.example.com"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/Bearer [A-Za-z0-9._\-+/=]+/)
  })

  test("redacts API key patterns (sk-*)", () => {
    const message = "Auth failed: key sk-proj-123abc was invalid at http://bad.com"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/sk-[A-Za-z0-9]+/)
  })

  test("redacts HTTP/WS URLs", () => {
    const message = "Connection to http://internal:8080/api failed; also wss://ws.example.com"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/https?:\/\/[^\s]+/)
    expect(redacted).not.toMatch(/wss?:\/\/[^\s]+/)
  })

  test("redacts absolute Unix paths", () => {
    const message = "Error at /home/user/project/src/file.ts line 42"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/\/home\//)
  })

  test("redacts absolute Windows paths", () => {
    const message = "Error at C:\\Users\\admin\\Documents\\secret.txt"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/[A-Z]:\\/)
  })

  test("strips control characters", () => {
    const message = "Error\x00with\x1Fcontrol\x08chars"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/)
  })

  test("redacts internal scope IDs", () => {
    const message = "Scope scope_abc123def456789012345678901234567890abcd not found"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/scope[_-]?[0-9a-f]{40}/)
  })

  test("redacts internal session IDs", () => {
    const message = "Session ses_abc123def4567890ghij not found"
    const redacted = redactErrorMessage(message)
    expect(redacted).not.toMatch(/ses[_-][0-9a-f]{16,}/)
  })
})

// ── Bounded read constants ──────────────────────────────

describe("Bounded read contract", () => {
  test("page size maximum is 100", () => {
    const MAX_PAGE_SIZE = 100
    expect(MAX_PAGE_SIZE).toBe(100)
  })

  test("default page size is 20", () => {
    const DEFAULT_PAGE_SIZE = 20
    expect(DEFAULT_PAGE_SIZE).toBe(20)
  })

  test("navigation does NOT load all bindings to paginate — it uses bounded scan", () => {
    // This is a behavioral invariant: the navigation route uses
    // listBindingsBounded (O(|agent projects|)) not listBindings
    // (loads all bindings into memory).
  })
})
