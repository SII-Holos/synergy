import { describe, expect, test } from "bun:test"
import { pageContextFromUrl } from "./browser-metrics"

describe("browser performance metrics", () => {
  test("builds safe route and session context", () => {
    expect(pageContextFromUrl("/session/1234567890abcdef", "?sessionID=ses_abc-123&scopeID=scope:def")).toEqual({
      routeName: "session.1234567890abcdef",
      pathTemplate: "/session/:id",
      sessionID: "ses_abc-123",
      scopeID: "scope:def",
    })
  })

  test("strips unsafe context characters and query data", () => {
    expect(
      pageContextFromUrl("/files/super-secret-token-value", "?sessionID=ses_abc%0Asecret&scopeID=<scope>"),
    ).toEqual({
      routeName: "files.super-secret-token-value",
      pathTemplate: "/files/super-secret-token-value",
      sessionID: "ses_abcsecret",
      scopeID: "scope",
    })
  })
})
