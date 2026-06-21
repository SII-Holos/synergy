import { describe, test, expect, beforeEach } from "bun:test"
import { RiskClassifier } from "@/permission/classifier"

describe("RiskClassifier.shouldAutoAllow", () => {
  beforeEach(() => {
    RiskClassifier.resetCircuitBreaker()
  })

  test("allows safe + high confidence", () => {
    expect(RiskClassifier.shouldAutoAllow({ risk: "safe", reason: "read-only", confidence: 0.9 })).toBe(true)
  })

  test("rejects safe + low confidence", () => {
    expect(RiskClassifier.shouldAutoAllow({ risk: "safe", reason: "unsure", confidence: 0.7 })).toBe(false)
  })

  test("rejects risky regardless of confidence", () => {
    expect(RiskClassifier.shouldAutoAllow({ risk: "risky", reason: "network", confidence: 0.95 })).toBe(false)
  })

  test("rejects dangerous", () => {
    expect(RiskClassifier.shouldAutoAllow({ risk: "dangerous", reason: "data loss", confidence: 0.99 })).toBe(false)
  })

  test("rejects undefined classification", () => {
    expect(RiskClassifier.shouldAutoAllow(undefined)).toBe(false)
  })
})

describe("RiskClassifier circuit breaker", () => {
  beforeEach(() => {
    RiskClassifier.resetCircuitBreaker()
  })

  test("starts enabled", () => {
    expect(RiskClassifier.isAutoDisabled()).toBe(false)
  })

  test("disables after 3 consecutive disagreements", () => {
    // 3 disagreements: classifier said dangerous but user allowed
    RiskClassifier.recordUserFeedback(
      { risk: "dangerous", reason: "rm -rf", confidence: 0.95 },
      true, // user allowed
    )
    expect(RiskClassifier.isAutoDisabled()).toBe(false)

    RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "git reset", confidence: 0.9 }, true)
    expect(RiskClassifier.isAutoDisabled()).toBe(false)

    RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "force push", confidence: 0.85 }, true)
    expect(RiskClassifier.isAutoDisabled()).toBe(true)
  })

  test("resets on agreement", () => {
    // 2 disagreements
    RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    expect(RiskClassifier.isAutoDisabled()).toBe(false)

    // Agreement resets counter
    RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "rm", confidence: 0.9 }, false)
    expect(RiskClassifier.isAutoDisabled()).toBe(false)

    // Now need 3 more to trip
    RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    expect(RiskClassifier.isAutoDisabled()).toBe(false)
  })

  test("ignores low-confidence classifications", () => {
    // Low-confidence disagreements don't count
    for (let i = 0; i < 5; i++) {
      RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "?", confidence: 0.5 }, true)
    }
    expect(RiskClassifier.isAutoDisabled()).toBe(false)
  })

  test("resetCircuitBreaker re-enables", () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    }
    expect(RiskClassifier.isAutoDisabled()).toBe(true)

    RiskClassifier.resetCircuitBreaker()
    expect(RiskClassifier.isAutoDisabled()).toBe(false)
  })

  test("when disabled, shouldAutoAllow always returns false", () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      RiskClassifier.recordUserFeedback({ risk: "dangerous", reason: "rm", confidence: 0.9 }, true)
    }
    // Even a safe high-confidence classification won't auto-allow
    expect(RiskClassifier.shouldAutoAllow({ risk: "safe", reason: "read", confidence: 0.99 })).toBe(false)
  })
})
