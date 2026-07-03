import { describe, expect, test } from "bun:test"
import {
  defaultNewSessionWorkspaceSelection,
  isSessionRunningForWorkspaceChange,
  reduceWorkspaceTransitionProgress,
  worktreeOptionSelection,
} from "./worktree-session"

describe("new session workspace selection", () => {
  test("defaults to main checkout from the canonical project root", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        currentDirectory: "/repo",
        canonicalDirectory: "/repo",
      }),
    ).toEqual({ mode: "current" })
  })

  test("defaults to the existing worktree when the URL is already in a worktree", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        currentDirectory: "/repo/.synergy/worktrees/feature",
        canonicalDirectory: "/repo",
      }),
    ).toEqual({ mode: "existing", target: "/repo/.synergy/worktrees/feature" })
  })

  test("preserves an explicit create-new selection", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        selected: { mode: "create" },
        currentDirectory: "/repo",
        canonicalDirectory: "/repo",
      }),
    ).toEqual({ mode: "create" })
  })

  test("maps the worktree option to existing when already inside a worktree", () => {
    expect(
      worktreeOptionSelection({
        currentDirectory: "/repo/.synergy/worktrees/feature",
        canonicalDirectory: "/repo",
      }),
    ).toEqual({ mode: "existing", target: "/repo/.synergy/worktrees/feature" })
  })

  test("maps the worktree option to create from the main checkout", () => {
    expect(worktreeOptionSelection({ currentDirectory: "/repo", canonicalDirectory: "/repo" })).toEqual({
      mode: "create",
    })
  })
})

describe("workspace change disabled state", () => {
  test("disables for local pending state", () => {
    expect(isSessionRunningForWorkspaceChange({ pending: true, status: { type: "idle" } })).toBe(true)
  })

  test("disables for non-idle runtime statuses", () => {
    for (const type of ["busy", "retry", "recovering"]) {
      expect(isSessionRunningForWorkspaceChange({ status: { type } })).toBe(true)
    }
  })

  test("disables for session working metadata", () => {
    expect(isSessionRunningForWorkspaceChange({ working: { status: "busy" }, status: { type: "idle" } })).toBe(true)
  })

  test("allows idle sessions without local pending state", () => {
    expect(isSessionRunningForWorkspaceChange({ status: { type: "idle" } })).toBe(false)
  })
})

describe("workspace transition progress reducer", () => {
  test("advances through idle, form, loading, success, and error", () => {
    const idle = { phase: "idle" as const }
    const form = reduceWorkspaceTransitionProgress(idle, { type: "open", operation: "enter" })
    expect(form).toEqual({ phase: "form", operation: "enter" })

    const loading = reduceWorkspaceTransitionProgress(form, { type: "load", step: "Creating worktree" })
    expect(loading).toEqual({ phase: "loading", operation: "enter", step: "Creating worktree" })

    expect(reduceWorkspaceTransitionProgress(loading, { type: "load", step: "Duplicate" })).toBe(loading)

    const success = reduceWorkspaceTransitionProgress(loading, { type: "succeed", message: "Moved" })
    expect(success).toEqual({ phase: "success", operation: "enter", message: "Moved" })

    const error = reduceWorkspaceTransitionProgress(form, { type: "fail", message: "Failed" })
    expect(error).toEqual({ phase: "error", operation: "enter", message: "Failed" })
  })
})
