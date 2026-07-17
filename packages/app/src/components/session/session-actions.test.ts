import { describe, expect, test } from "bun:test"
import { sessionActionVisibility, sessionScopeRequest } from "./session-actions"

describe("session action visibility", () => {
  test("keeps transfer actions available for open Home sessions", () => {
    expect(sessionActionVisibility({ sessionID: "ses_home", scopeKey: "home" })).toEqual({
      menu: true,
      scopeSpecific: false,
    })
  })

  test("keeps all actions available for open project sessions", () => {
    expect(sessionActionVisibility({ sessionID: "ses_project", scopeKey: "/repo" })).toEqual({
      menu: true,
      scopeSpecific: true,
    })
  })

  test("hides the action menu when no session is open", () => {
    expect(sessionActionVisibility({ scopeKey: "home" })).toEqual({
      menu: false,
      scopeSpecific: false,
    })
  })
})

describe("session transfer scope request", () => {
  test("addresses Home through its scope ID", () => {
    expect(sessionScopeRequest("home")).toEqual({ scopeID: "home" })
  })

  test("addresses non-Home scopes through their directory key", () => {
    expect(sessionScopeRequest("/repo")).toEqual({ directory: "/repo" })
  })
})
