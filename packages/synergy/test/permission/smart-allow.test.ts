import { describe, test, expect, beforeEach } from "bun:test"
import { SmartAllow } from "@/permission/smart-allow"

describe("SmartAllow.shouldAutoAllow", () => {
  beforeEach(() => {
    SmartAllow.resetCircuitBreaker()
  })

  test("allows safe + high confidence", () => {
    expect(SmartAllow.shouldAutoAllow({ risk: "safe", reason: "read-only", confidence: 0.9 })).toBe(true)
  })

  test("allows safe + high confidence soft deny classification", () => {
    const caps = [{ class: "file_write", nonBypassable: false }]
    expect(SmartAllow.isEligible("deny", caps)).toBe(true)
    expect(SmartAllow.shouldAutoAllow({ risk: "safe", reason: "workspace-local edit", confidence: 0.9 })).toBe(true)
  })

  test("rejects safe + low confidence", () => {
    expect(SmartAllow.shouldAutoAllow({ risk: "safe", reason: "unsure", confidence: 0.7 })).toBe(false)
  })

  test("rejects risky regardless of confidence", () => {
    expect(SmartAllow.shouldAutoAllow({ risk: "risky", reason: "network", confidence: 0.95 })).toBe(false)
  })

  test("rejects dangerous", () => {
    expect(SmartAllow.shouldAutoAllow({ risk: "dangerous", reason: "data loss", confidence: 0.99 })).toBe(false)
  })

  test("rejects undefined classification", () => {
    expect(SmartAllow.shouldAutoAllow(undefined)).toBe(false)
  })
})

describe("SmartAllow eligibility", () => {
  test("allows soft ask and soft deny candidates", () => {
    const caps = [{ class: "file_write", nonBypassable: false }]
    expect(SmartAllow.isEligible("ask", caps)).toBe(true)
    expect(SmartAllow.isEligible("deny", caps)).toBe(true)
  })

  test("rejects non-bypassable and opaque capabilities", () => {
    expect(SmartAllow.isEligible("ask", [{ class: "file_write", nonBypassable: true }])).toBe(false)
    expect(SmartAllow.isEligible("ask", [{ class: "file_write", nonBypassable: false, opaque: true }])).toBe(false)
  })

  test("rejects hard capability classes even when marked bypassable", () => {
    expect(SmartAllow.isEligible("deny", [{ class: "shell_destructive", nonBypassable: false }])).toBe(false)
    expect(SmartAllow.isEligible("deny", [{ class: "identity_act", nonBypassable: false }])).toBe(false)
    expect(SmartAllow.isEligible("deny", [{ class: "plugin_secret_read", nonBypassable: false }])).toBe(false)
  })
})

describe("SmartAllow circuit breaker", () => {
  beforeEach(() => {
    SmartAllow.resetCircuitBreaker()
  })

  test("starts enabled", () => {
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)
  })

  test("disables after 3 consecutive disagreements in the same session", () => {
    SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm -rf", confidence: 0.95 }, true)
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)

    SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "git reset", confidence: 0.9 }, true)
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)

    SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "force push", confidence: 0.85 }, true)
    expect(SmartAllow.isDisabled("ses_a")).toBe(true)
  })

  test("does not leak circuit breaker state across sessions", () => {
    for (let i = 0; i < 3; i++) {
      SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    }

    expect(SmartAllow.isDisabled("ses_a")).toBe(true)
    expect(SmartAllow.isDisabled("ses_b")).toBe(false)
    expect(SmartAllow.shouldAutoAllow({ risk: "safe", reason: "read", confidence: 0.99 }, "ses_b")).toBe(true)
  })

  test("resets on agreement", () => {
    SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)

    SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm", confidence: 0.9 }, false)
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)

    SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)
  })

  test("ignores low-confidence classifications", () => {
    for (let i = 0; i < 5; i++) {
      SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "?", confidence: 0.5 }, true)
    }
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)
  })

  test("resetCircuitBreaker re-enables a session", () => {
    for (let i = 0; i < 3; i++) {
      SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    }
    expect(SmartAllow.isDisabled("ses_a")).toBe(true)

    SmartAllow.resetCircuitBreaker("ses_a")
    expect(SmartAllow.isDisabled("ses_a")).toBe(false)
  })

  test("when disabled, shouldAutoAllow returns false for that session", () => {
    for (let i = 0; i < 3; i++) {
      SmartAllow.recordUserFeedback("ses_a", { risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    }

    expect(SmartAllow.shouldAutoAllow({ risk: "safe", reason: "read", confidence: 0.99 }, "ses_a")).toBe(false)
  })
})
