import { describe, expect, test } from "bun:test"
import { normalizeBrowserError, toBrowserError } from "./browser-error"

describe("Browser API errors", () => {
  test("preserves structured SDK errors instead of stringifying objects", () => {
    const input = {
      type: "error",
      code: "browser_host_unavailable",
      message: "Browser Host is unavailable.",
      retryable: true,
    }
    expect(normalizeBrowserError(input, "fallback")).toEqual({
      code: "browser_host_unavailable",
      message: "Browser Host is unavailable.",
      retryable: true,
    })
    expect(toBrowserError(input, "fallback")).toMatchObject({
      message: "Browser Host is unavailable.",
      code: "browser_host_unavailable",
      retryable: true,
    })
  })

  test("uses a stable fallback for unknown thrown values", () => {
    expect(normalizeBrowserError({ unexpected: true }, "Browser request failed").message).toBe("Browser request failed")
  })
})
