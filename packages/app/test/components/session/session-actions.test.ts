import { describe, expect, test } from "bun:test"
import {
  sessionActionVisibility,
  sessionModelControlVisibility,
  sessionScopeRequest,
  sessionScopeRequestFor,
  type SessionScopeRequest,
} from "../../../src/components/session/session-actions"

describe("session action visibility", () => {
  test("keeps worktree project-only while Home sessions expose every menu action", () => {
    expect(sessionActionVisibility({ sessionID: "ses_home", scopeKey: "home" })).toEqual({
      menu: true,
      rename: true,
      worktree: false,
      export: true,
      import: true,
      archive: true,
      copySessionID: true,
    })
  })

  test("keeps all actions available for open project sessions", () => {
    expect(sessionActionVisibility({ sessionID: "ses_project", scopeKey: "/repo" })).toEqual({
      menu: true,
      rename: true,
      worktree: true,
      export: true,
      import: true,
      archive: true,
      copySessionID: true,
    })
  })

  test("hides every session action when no session is open", () => {
    expect(sessionActionVisibility({ scopeKey: "home" })).toEqual({
      menu: false,
      rename: false,
      worktree: false,
      export: false,
      import: false,
      archive: false,
      copySessionID: false,
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

describe("session scope request for session payloads", () => {
  const homeSession = {
    scope: { id: "home", type: "home", directory: "/Users/example" },
  } satisfies Parameters<typeof sessionScopeRequestFor>[0]

  test("addresses Home sessions through the home scope ID, not the home directory", () => {
    expect(sessionScopeRequestFor(homeSession)).toEqual({ scopeID: "home" })
  })

  test("addresses project sessions through their directory", () => {
    expect(sessionScopeRequestFor({ scope: { id: "d_abc", type: "project", directory: "/repo" } })).toEqual({
      directory: "/repo",
    } satisfies SessionScopeRequest)
  })
})

describe("session model control visibility", () => {
  test("hides both model controls when the represented session cannot change models", () => {
    expect(sessionModelControlVisibility({ canSelectModel: false, variantCount: 3 })).toEqual({
      model: false,
      variant: false,
    })
  })

  test("shows effort only when an editable session has model variants", () => {
    expect(sessionModelControlVisibility({ canSelectModel: true, variantCount: 0 })).toEqual({
      model: true,
      variant: false,
    })
    expect(sessionModelControlVisibility({ canSelectModel: true, variantCount: 2 })).toEqual({
      model: true,
      variant: true,
    })
  })
})
