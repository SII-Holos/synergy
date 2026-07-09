import { describe, test, expect, beforeEach } from "bun:test"
import { SmartAllow } from "@/permission/smart-allow"

describe("SmartAllow.shouldAutoAllow", () => {
  beforeEach(() => {
    SmartAllow.resetCircuitBreaker()
  })

  test("allows safe + high confidence", () => {
    expect(SmartAllow.shouldAutoAllow({ risk: "safe", reason: "read-only", confidence: 0.9 })).toBe(true)
  })

  test("allows safe + high confidence soft deny classification at autonomous threshold", () => {
    const caps = [{ class: "file_write", nonBypassable: false }]
    expect(SmartAllow.isEligible("deny", caps)).toBe(true)
    expect(
      SmartAllow.shouldAutoAllow({ risk: "safe", reason: "workspace-local edit", confidence: 0.9 }, undefined, "deny"),
    ).toBe(true)
  })

  test("rejects safe + low confidence", () => {
    expect(SmartAllow.shouldAutoAllow({ risk: "safe", reason: "unsure", confidence: 0.7 })).toBe(false)
  })

  test("requires higher confidence for deny auto-allow", () => {
    const classification = { risk: "safe" as const, reason: "likely false positive", confidence: 0.86 }
    expect(SmartAllow.shouldAutoAllow(classification, undefined, "ask")).toBe(true)
    expect(SmartAllow.shouldAutoAllow(classification, undefined, "deny")).toBe(false)
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
    expect(SmartAllow.isEligible("deny", [{ class: "shell_destructive", nonBypassable: false }])).toBe(true)
    expect(SmartAllow.isEligible("deny", [{ class: "identity_act", nonBypassable: false }])).toBe(true)
    expect(SmartAllow.isEligible("deny", [{ class: "secrets", nonBypassable: false }])).toBe(true)
  })

  test("allows explicitly marked secret-candidate false positives", () => {
    expect(
      SmartAllow.isEligible("ask", [
        {
          class: "secrets",
          nonBypassable: false,
          metadata: { smartAllowEligible: true, redactedEvidenceRequired: true },
        },
      ]),
    ).toBe(true)
  })

  test("rejects exact secret roots", () => {
    expect(
      SmartAllow.isEligible("deny", [
        { class: "secrets", nonBypassable: true, opaque: true, metadata: { exactSecretRoot: true } },
      ]),
    ).toBe(false)
  })

  test("redacted evidence omits original secret values", () => {
    const evidence = SmartAllow.buildRedactedEvidence(
      { content: "OPENAI_API_KEY=sk-this-is-a-real-looking-secret-value\nDEBUG=true\nTOKEN=your_token_here" },
      [{ class: "secrets", nonBypassable: false, metadata: { redactedEvidenceRequired: true } }],
    )
    expect(evidence?.redacted).toBe(true)
    const joined = evidence?.summary.join("\n") ?? ""
    expect(joined).not.toContain("sk-this-is-a-real-looking-secret-value")
    expect(joined).toContain("OPENAI_API_KEY=<redacted:length=")
    expect(joined).toContain("TOKEN=<placeholder>")
  })
})

describe("SmartAllow prompt context", () => {
  test("includes redacted session context for intent disambiguation", () => {
    const prompt = SmartAllow.buildPrompt({
      tool: "bash",
      args: { command: "git push origin feature" },
      capabilities: ["network", "shell_git_remote"],
      workspace: "/repo",
      policyAction: "ask",
      userMessage: "Please open a PR for the fix.",
      recentHistory: ["user: run the issue workflow", "assistant: created the branch"],
      agentContext: "synergy: general coding agent",
    })

    expect(prompt).toContain("Session context")
    expect(prompt).toContain("User request: Please open a PR for the fix.")
    expect(prompt).toContain("- user: run the issue workflow")
    expect(prompt).toContain("Agent: synergy: general coding agent")
  })

  test("redacts secret-like values from session context", () => {
    const prompt = SmartAllow.buildPrompt({
      tool: "bash",
      args: { command: "echo done" },
      capabilities: ["shell_exec"],
      workspace: "/repo",
      policyAction: "ask",
      userMessage: "Use OPENAI_API_KEY=sk-this-is-a-real-looking-secret-value-for-tests",
      recentHistory: ["assistant: saw token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    })

    expect(prompt).not.toContain("sk-this-is-a-real-looking-secret-value-for-tests")
    expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    expect(prompt).toContain("OPENAI_API_KEY=<redacted>")
    expect(prompt).toContain("<redacted:token>")
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
