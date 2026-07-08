import { describe, expect, test } from "bun:test"
import {
  createNewSessionWorkspaceProgress,
  createWorkspaceTransitionErrorProgress,
  createWorkspaceTransitionLoadingProgress,
  createWorkspaceTransitionSuccessProgress,
  defaultNewSessionWorkspaceSelection,
  isSessionRunningForWorkspaceChange,
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

describe("workspace transition progress model", () => {
  test("creates existing-session enter loading, success, and retryable error states", () => {
    const request = { operation: "enter" as const, sessionID: "ses_1", directory: "/repo", name: "feature" }
    const loading = createWorkspaceTransitionLoadingProgress(request)

    expect(loading.phase).toBe("loading")
    expect(loading.operation).toBe("enter")
    expect(loading.steps.map((step) => [step.label, step.state])).toEqual([
      ["Create checkout", "active"],
      ["Move to worktree", "pending"],
    ])

    const success = createWorkspaceTransitionSuccessProgress({ operation: "enter" })
    expect(success.title).toBe("Worktree active")
    expect(success.description).toContain("isolated checkout")
    expect(success.steps.every((step) => step.state === "complete")).toBe(true)

    const retry = () => undefined
    const error = createWorkspaceTransitionErrorProgress({ operation: "enter", message: "Failed", retry })
    expect(error).toMatchObject({ phase: "error", operation: "enter", title: "Move to worktree failed" })
    expect(error.description).toBe("Failed")
    expect(error.retry).toBe(retry)
  })

  test("creates existing-session leave loading and success states", () => {
    const loading = createWorkspaceTransitionLoadingProgress({
      operation: "leave",
      sessionID: "ses_1",
      directory: "/repo",
    })

    expect(loading.steps.map((step) => [step.label, step.state])).toEqual([["Return to main checkout", "active"]])

    const success = createWorkspaceTransitionSuccessProgress({ operation: "leave" })
    expect(success.title).toBe("Main checkout active")
    expect(success.description).toContain("main checkout")
    expect(success.steps.map((step) => [step.label, step.state])).toEqual([["Return to main checkout", "complete"]])
  })

  test("creates new-session worktree startup steps for create and existing modes", () => {
    const createProgress = createNewSessionWorkspaceProgress({ selection: { mode: "create" }, stage: "workspace" })
    expect(createProgress.steps.map((step) => step.label)).toEqual([
      "Create checkout",
      "Prepare session",
      "Send prompt",
    ])
    expect(createProgress.steps.map((step) => step.state)).toEqual(["active", "pending", "pending"])

    const existingProgress = createNewSessionWorkspaceProgress({
      selection: { mode: "existing", target: "/repo/.synergy/worktrees/feature" },
      stage: "prompt",
    })
    expect(existingProgress.steps.map((step) => [step.label, step.state])).toEqual([
      ["Bind worktree", "complete"],
      ["Prepare session", "complete"],
      ["Send prompt", "active"],
    ])
  })
})
