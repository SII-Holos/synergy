import { describe, expect, test } from "bun:test"
import { BrowserProtocolError } from "../src/error"
import { redactBrowserHeaders, redactBrowserText, redactBrowserURL } from "../src/redaction"

describe("Browser redaction", () => {
  test("removes credentials, secret query fields, fragments, headers, and bearer tokens", () => {
    const url = redactBrowserURL("https://user:pass@example.com/path?token=abc&view=ok#access_token=secret")
    expect(url).not.toContain("user")
    expect(url).not.toContain("pass")
    expect(url).not.toContain("abc")
    expect(url).not.toContain("secret")
    expect(url).toContain("view=ok")
    expect(redactBrowserHeaders({ Authorization: "Bearer token", Accept: "text/html" })).toEqual({
      Authorization: "[redacted]",
      Accept: "text/html",
    })
    expect(redactBrowserText("authorization=Bearer abc.def")).not.toContain("abc.def")
  })

  test("redacts structured errors before they can reach logs", () => {
    const error = new BrowserProtocolError({
      code: "browser_test",
      message: "authorization=top-secret",
      retryable: false,
      url: "https://user:password@example.com/path?token=top-secret",
    })
    expect(error.message).not.toContain("top-secret")
    expect(error.url).not.toContain("top-secret")
    expect(error.url).not.toContain("password")
  })
})
