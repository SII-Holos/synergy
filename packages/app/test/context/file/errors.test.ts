import { describe, expect, test } from "bun:test"
import { isWorkspaceFileNotFoundError, removePathTree } from "../../../src/context/file/errors"

describe("workspace file missing-resource recovery", () => {
  test("recognizes SDK not-found response objects", () => {
    expect(isWorkspaceFileNotFoundError({ name: "NotFoundError", data: { message: "Resource not found" } })).toBe(true)
    expect(isWorkspaceFileNotFoundError(new Error("Resource not found"))).toBe(false)
  })

  test("removes a missing directory and its descendants from persisted expansion state", () => {
    expect(removePathTree(["docs", "docs/packs", "docs/packs/archive", "catalog", "src"], "docs")).toEqual([
      "catalog",
      "src",
    ])
  })
})
