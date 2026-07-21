import { describe, expect, test } from "bun:test"
import { promptSubmitFailure } from "./submit-failure"

describe("prompt submit failure presentation", () => {
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
