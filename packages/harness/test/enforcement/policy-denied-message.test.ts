import { describe, expect, test } from "bun:test"
import { EnforcementError } from "../../src/enforcement/errors"

describe("PolicyDenied model-facing message", () => {
  test("renders a transient classification failure as retryable infrastructure, not a policy decision", () => {
    const error = new EnforcementError.PolicyDenied(
      "Policy classification is unavailable (PolicyWorkerTimeoutError); the operation was not executed",
      ["protected_op"],
      "guarded",
      { permanent: false, guidance: "Retry after the Policy worker has recovered." },
    )

    expect(error.retryable).toBe(true)
    expect(error.permanent).toBe(false)
    expect(error.modelMessage).not.toContain("Do not retry the same approach")
    expect(error.modelMessage).toContain("Retry after the Policy worker has recovered.")
    expect(error.modelMessage).toContain("PolicyWorkerTimeoutError")
  })

  test("keeps permanent profile denials on the existing policy wording", () => {
    const error = new EnforcementError.PolicyDenied(
      'Profile "autonomous" denies capability "secrets"',
      ["secrets"],
      "autonomous",
    )

    expect(error.retryable).toBe(false)
    expect(error.permanent).toBe(true)
    expect(error.modelMessage).toContain('Permission denied by profile "autonomous".')
    expect(error.modelMessage).toContain("Blocked capabilities: secrets")
    expect(error.modelMessage).toContain("This is a policy restriction. Do not retry the same approach.")
  })

  test("treats a denial without explicit permanence as permanent", () => {
    const error = new EnforcementError.PolicyDenied("Blocked by user permission rule: bash(rm)", ["shell"], "guarded")

    expect(error.permanent).toBe(true)
    expect(error.retryable).toBe(false)
  })
})
