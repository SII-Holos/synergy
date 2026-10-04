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

  test("only renders string fields from structured errors", () => {
    expect(requestErrorMessage({ data: { message: { detail: "failed" }, error: 503 } }, "Unavailable")).toBe(
      "Unavailable",
    )
    expect(requestErrorMessage({ data: { message: [], error: {} }, message: "Try again" })).toBe("Try again")
    expect(requestErrorMessage({ data: "invalid", message: false }, "Unavailable")).toBe("Unavailable")
    expect(requestErrorMessage(new Error("Offline"))).toBe("Offline")
    expect(requestErrorMessage({ name: "SessionDisplayConflict", data: { message: "Refresh its summary" } })).toBe(
      "Refresh its summary",
    )
  })
})
