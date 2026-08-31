import { describe, expect, test } from "bun:test"
import { BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { withUnknownOutcomeGuidance } from "../../src/tool/browser-shared"

const unknownOutcomeCodes = [
  "browser_command_aborted",
  "browser_host_timeout",
  "browser_host_unavailable",
  "browser_host_pending",
  "browser_session_closing",
  "browser_command_failed",
  "browser_result_too_large",
] as const

describe("withUnknownOutcomeGuidance", () => {
  test("steers every unknown-outcome code to verification and never to re-execution", () => {
    for (const code of unknownOutcomeCodes) {
      const guided = withUnknownOutcomeGuidance(
        new BrowserProtocolError({
          code,
          message: "The Browser Host went away before a verdict.",
          retryable: true,
          commandId: "call-1:navigate",
          pageId: "page-test",
        }),
        "browser_navigation goto",
      )

      expect(guided).toBeInstanceOf(BrowserProtocolError)
      const error = guided as BrowserProtocolError
      expect(error.code).toBe(code)
      expect(error.commandId).toBe("call-1:navigate")
      expect(error.message).toContain("outcome of browser_navigation goto is unknown")
      expect(error.message).toContain("Do NOT re-execute it")
      expect(error.suggestedAction).toContain("browser_navigation current")
      expect(error.suggestedAction).toContain("browser_snapshot")
      expect(error.suggestedAction).toContain("browser_read")
      expect(error.suggestedAction).toContain("a fresh call")
    }
  })

  test("leaves verdict-carrying errors, missing commandIds, and plain failures untouched", () => {
    const knownVerdict = new BrowserProtocolError({
      code: "browser_locator_not_found",
      message: "Locator did not match.",
      retryable: true,
      commandId: "call-1:action",
    })
    expect(withUnknownOutcomeGuidance(knownVerdict, "browser_action click")).toBe(knownVerdict)

    const withoutCommandId = new BrowserProtocolError({
      code: "browser_host_timeout",
      message: "Timed out before dispatch.",
      retryable: true,
    })
    expect(withUnknownOutcomeGuidance(withoutCommandId, "browser_action click")).toBe(withoutCommandId)

    const plain = new Error("plain failure")
    expect(withUnknownOutcomeGuidance(plain, "browser_action click")).toBe(plain)
  })
})

test("leaves idempotent navigation controls free to report their own verdict", () => {
  const error = new BrowserProtocolError({
    code: "browser_host_timeout",
    message: "The Browser Host request timed out.",
    retryable: true,
    commandId: "call-1:resume",
  })

  for (const command of ["browser_navigation resume", "browser_navigation close", "browser_navigation stop"]) {
    expect(withUnknownOutcomeGuidance(error, command)).toBe(error)
  }
})
