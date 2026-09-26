import { describe, expect, test } from "bun:test"
import { scopeUpdateErrorMessage, scopeUpdateRequest } from "../../../src/components/dialog/project-scope-edit-model"
import type { LocalScope } from "@/context/layout"

function scope(overrides: Partial<LocalScope> = {}): LocalScope {
  return {
    id: "abc123",
    local: { directory: "/repo", worktree: "/repo", sandboxes: [] },
    expanded: false,
    ...overrides,
  } as LocalScope
}

describe("scopeUpdateRequest", () => {
  test("updates the identified Scope independently of its local directory", () => {
    const request = scopeUpdateRequest(scope({ id: "abc123" }), { name: "renamed", sandboxes: ["/repo/docs"] })
    expect(request).toEqual({
      path_scopeID: "abc123",
      name: "renamed",
      sandboxes: ["/repo/docs"],
    })
  })

  test("omits an empty name and undefined sandboxes", () => {
    const request = scopeUpdateRequest(scope({ id: "abc123" }), { name: "   ", sandboxes: undefined })
    expect(request).toEqual({ path_scopeID: "abc123" })
  })
})

describe("scopeUpdateErrorMessage", () => {
  const fallback = "Unknown error"

  test("prefers data.message (SDK 4xx error body)", () => {
    const error = { name: "NotFoundError", data: { message: "Resource not found" } }
    expect(scopeUpdateErrorMessage(error, fallback)).toBe("Resource not found")
  })

  test("falls back to the top-level error field (handler validation errors)", () => {
    const error = { error: "Sandbox path must be absolute: relative/path" }
    expect(scopeUpdateErrorMessage(error, fallback)).toBe("Sandbox path must be absolute: relative/path")
  })

  test("falls back to message, then Error instance, then the fallback", () => {
    expect(scopeUpdateErrorMessage({ message: "plain message" }, fallback)).toBe("plain message")
    expect(scopeUpdateErrorMessage(new Error("boom"), fallback)).toBe("boom")
    expect(scopeUpdateErrorMessage(null, fallback)).toBe(fallback)
    expect(scopeUpdateErrorMessage("nope", fallback)).toBe(fallback)
    expect(scopeUpdateErrorMessage({ data: { message: "" }, error: "" }, fallback)).toBe(fallback)
  })
})
