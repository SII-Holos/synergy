import { describe, expect, test } from "bun:test"
import {
  fileWriteErrorMessage,
  isFileWriteConflictError,
  isFileWriteDeniedError,
  isWorkspaceFileNotFoundError,
  removePathTree,
} from "../../../src/context/file/errors"

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

describe("workspace file write error detection", () => {
  test("recognizes structured write conflict responses", () => {
    expect(
      isFileWriteConflictError({ name: "WorkspaceFileWriteConflictError", data: { message: "changed on disk" } }),
    ).toBe(true)
    expect(isFileWriteConflictError({ name: "WorkspaceFileAccessDeniedError", data: { message: "denied" } })).toBe(
      false,
    )
    expect(isFileWriteConflictError(new Error("changed on disk"))).toBe(false)
  })

  test("recognizes structured write denial responses", () => {
    expect(isFileWriteDeniedError({ name: "WorkspaceFileAccessDeniedError", data: { message: "not editable" } })).toBe(
      true,
    )
    expect(
      isFileWriteDeniedError({ name: "WorkspaceFileWriteConflictError", data: { message: "changed on disk" } }),
    ).toBe(false)
    expect(isFileWriteDeniedError(new Error("not editable"))).toBe(false)
  })

  test("extracts the message from structured error responses", () => {
    expect(fileWriteErrorMessage({ name: "WorkspaceFileAccessDeniedError", data: { message: "denied" } })).toBe(
      "denied",
    )
    expect(fileWriteErrorMessage({ message: "plain message" })).toBe("plain message")
    expect(fileWriteErrorMessage(new Error("plain"))).toBeUndefined()
    expect(fileWriteErrorMessage(undefined)).toBeUndefined()
  })
})
