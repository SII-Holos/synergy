import { describe, expect, test } from "bun:test"
import { classifyScopeEvent } from "../../../src/context/layout/event-routing"

describe("classifyScopeEvent", () => {
  test("scope.removed routes to scopeRemoval", () => {
    expect(classifyScopeEvent("scope.removed", false)).toBe("scopeRemoval")
    expect(classifyScopeEvent("scope.removed", true)).toBe("scopeRemoval")
  })

  test("non-archived scope.updated routes to scopeIndexRefresh", () => {
    expect(classifyScopeEvent("scope.updated", false)).toBe("scopeIndexRefresh")
  })

  test("archived scope.updated routes to scopeRemoval", () => {
    expect(classifyScopeEvent("scope.updated", true)).toBe("scopeRemoval")
  })

  test("session.updated routes to sessionUpdate", () => {
    expect(classifyScopeEvent("session.updated", false)).toBe("sessionUpdate")
    expect(classifyScopeEvent("session.updated", true)).toBe("sessionUpdate")
  })

  test("unknown type routes to ignore", () => {
    expect(classifyScopeEvent("some.other", false)).toBe("ignore")
  })

  test("undefined type routes to ignore", () => {
    expect(classifyScopeEvent(undefined, false)).toBe("ignore")
  })
})
