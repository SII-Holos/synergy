import { describe, expect, test } from "bun:test"
import {
  browserErrorPresentation,
  normalizeBrowserError,
  toBrowserError,
} from "../../../../src/components/workspace/browser/browser-error"

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

test("product errors explain recovery while keeping protocol details separate and redacted", () => {
  const timeout = browserErrorPresentation({
    code: "browser_cdp_timeout",
    message: "CDP command Page.navigate timed out after 10 seconds.",
  })
  expect(timeout.message).not.toMatch(/CDP|Page.navigate|10 seconds/)
  expect(timeout.message).toMatch(/page|operation/)
  expect(timeout.details).toContain("Page.navigate")
  expect(browserErrorPresentation({ code: "browser_load_-202", message: "net::ERR_CERT_AUTHORITY_INVALID" }).id).toBe(
    "browser.failure.certificate",
  )
  expect(browserErrorPresentation({ code: "browser_load_-106", message: "net::ERR_INTERNET_DISCONNECTED" }).id).toBe(
    "browser.failure.offline",
  )
  const unknown = browserErrorPresentation({ message: "internal failure at /Users/private/account?token=secret" })
  expect(unknown.message).not.toContain("private")
})
