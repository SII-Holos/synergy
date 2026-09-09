import { describe, expect, test } from "bun:test"
import { scopeUpdateErrorMessage, scopeUpdateRequest } from "../../../src/components/dialog/project-scope-edit-model"
import type { LocalScope } from "@/context/layout"

function scope(overrides: Partial<LocalScope> = {}): LocalScope {
  return {
    worktree: "/repo",
    expanded: false,
    ...overrides,
  } as LocalScope
}

describe("scopeUpdateRequest", () => {
  test("uses the stable scopeID when present and always carries directory", () => {
    const request = scopeUpdateRequest(scope({ id: "abc123" }), { name: "renamed", sandboxes: ["/repo/docs"] })
    expect(request).toEqual({
      path_scopeID: "abc123",
      directory: "/repo",
      name: "renamed",
      sandboxes: ["/repo/docs"],
    })
  })

  test("falls back to the worktree path as scopeID when the stable ID is missing", () => {
    const request = scopeUpdateRequest(scope({ id: undefined }), { sandboxes: ["/repo/docs"] })
    expect(request).toEqual({
      path_scopeID: "/repo",
      directory: "/repo",
      sandboxes: ["/repo/docs"],
    })
  })

  test("omits an empty name and undefined sandboxes", () => {
    const request = scopeUpdateRequest(scope({ id: "abc123" }), { name: "   ", sandboxes: undefined })
    expect(request).toEqual({ path_scopeID: "abc123", directory: "/repo" })
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
