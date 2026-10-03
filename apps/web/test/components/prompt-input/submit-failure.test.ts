import { describe, expect, test } from "bun:test"
import { promptSubmitFailure } from "../../../src/components/prompt-input/submit-failure"

describe("prompt submit failure presentation", () => {
  test("directory identity conflicts retain a targeted repair action", () => {
    expect(
      promptSubmitFailure({
        name: "WorkspaceUnavailable",
        data: {
          message: "Directory identity changed",
          workspaceID: "workspace-1",
          reason: "identity_changed",
        },
      }),
    ).toEqual({
      kind: "workspace-unavailable",
      message: "Directory identity changed",
      workspaceID: "workspace-1",
      reason: "identity_changed",
    })
  })
  test("unwraps an identity conflict without losing the recovery target", () => {
    const data = { message: "Verify the directory", workspaceID: "workspace-1", reason: "identity_changed" }
    const error = Object.assign(new Error("Conflict"), {
      name: "APIError",
      data: {
        statusCode: 409,
        responseBody: JSON.stringify({ name: "WorkspaceUnavailable", data }),
      },
    })
    expect(promptSubmitFailure(error)).toEqual({ kind: "workspace-unavailable", ...data })
  })
  test("routes a missing session worktree to the blocking workspace reminder", () => {
    expect(
      promptSubmitFailure({
        name: "WorktreeUnavailableError",
        data: {
          message: "The worktree for this session is no longer available.",
          reason: "missing",
        },
      }),
    ).toEqual({
      kind: "worktree-unavailable",
      message: "The worktree for this session is no longer available.",
    })
  })

  test("recognizes the generated client's wrapped conflict response", () => {
    const error = Object.assign(new Error("Conflict"), {
      name: "APIError",
      data: {
        message: "Conflict",
        statusCode: 409,
        responseBody: JSON.stringify({
          name: "WorktreeUnavailableError",
          data: {
            message: "The worktree for this session is no longer available.",
            reason: "missing",
          },
        }),
      },
    })

    expect(promptSubmitFailure(error)).toEqual({
      kind: "worktree-unavailable",
      message: "The worktree for this session is no longer available.",
    })
  })

  test("keeps unrelated failures on the generic send-error path", () => {
    expect(promptSubmitFailure({ name: "APIError", data: { message: "Network unavailable" } })).toEqual({
      kind: "generic",
      message: "Network unavailable",
    })
  })
})
