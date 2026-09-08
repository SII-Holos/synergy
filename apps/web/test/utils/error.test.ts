import { describe, expect, test } from "bun:test"
import { requestErrorMessage } from "../../src/utils/error"

describe("requestErrorMessage", () => {
  test("preserves generated SDK JSON error messages", () => {
    expect(
      requestErrorMessage(
        {
          code: "PERF_ANALYSIS_UNAVAILABLE",
          message: "Performance analysis requires an available Thinking model.",
        },
        "Unable to load performance data right now.",
      ),
    ).toBe("Performance analysis requires an available Thinking model.")
  })

  test("preserves raw response text errors", () => {
    expect(requestErrorMessage("Service unavailable", "Request failed")).toBe("Service unavailable")
  })

  test("preserves nested error messages used by note requests", () => {
    expect(requestErrorMessage({ data: { error: "Blueprint failed" } }, "Request failed")).toBe("Blueprint failed")
  })

  test("uses a top-level message when nested data has no message", () => {
    expect(requestErrorMessage({ data: {}, message: "Try again" }, "Request failed")).toBe("Try again")
  })

  test("returns the fallback for message-free objects", () => {
    expect(requestErrorMessage({ code: "REQUEST_FAILED" }, "Request failed")).toBe("Request failed")
  })
})
