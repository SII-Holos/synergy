import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { translateDescriptor } from "@/locales/translate"
import { S } from "../../../src/components/session/session-i18n"
import {
  translateSessionTransitionCopy,
  type SessionTransitionProgress,
} from "../../../src/components/session/session-transition-progress"
import {
  createNewSessionWorkspaceProgress,
  createNewSessionWorkspaceErrorProgress,
  createNewSessionWorkspaceSuccessProgress,
  createWorkspaceTransitionErrorProgress,
  createWorkspaceTransitionLoadingProgress,
  createWorkspaceTransitionSuccessProgress,
  defaultNewSessionWorkspaceSelection,
  isSessionRunningForWorkspaceChange,
  isWorktreeWorkspaceSelection,
  worktreeOptionSelection,
  worktreeSetupFailureMessage,
} from "../../../src/components/session/worktree-session"

function englishI18n() {
  const i18n = setupI18n({ locale: "en" })
  i18n.loadAndActivate({
    locale: "en",
    messages: Object.fromEntries(Object.values(S).map((descriptor) => [descriptor.id, descriptor.message])),
  })
  return i18n
}

function translateProgressCopy(copy: SessionTransitionProgress["title"]): string {
  return translateSessionTransitionCopy(copy, englishI18n())
}

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
  test("creates existing-session enter loading, success, and pure error states", () => {
    const i18n = englishI18n()
    const request = { operation: "enter" as const, sessionID: "ses_1", directory: "/repo", name: "feature" }
    const loading = createWorkspaceTransitionLoadingProgress(request)

    expect(loading.phase).toBe("loading")
    expect(loading.kind).toBe("enter-worktree")
    expect(loading.steps.map((step) => [translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["Create and bind checkout", "active"],
    ])

    const success = createWorkspaceTransitionSuccessProgress({ operation: "enter" })
    expect(translateProgressCopy(success.title)).toBe("Worktree active")
    expect(translateProgressCopy(success.description)).toContain("isolated checkout")
    expect(success.steps.every((step) => step.state === "complete")).toBe(true)

    const error = createWorkspaceTransitionErrorProgress({ operation: "enter", message: "Failed" })
    expect(error).toMatchObject({ phase: "error", kind: "enter-worktree" })
    expect(translateProgressCopy(error.title)).toBe("Move to worktree failed")
    expect(error.description).toBe("Failed")
    expect("retry" in error).toBe(false)
    expect("dismiss" in error).toBe(false)
    expect(JSON.parse(JSON.stringify(error))).toEqual(error)
  })

  test("creates existing-session leave loading and success states", () => {
    const i18n = englishI18n()
    const loading = createWorkspaceTransitionLoadingProgress({
      operation: "leave",
      sessionID: "ses_1",
      directory: "/repo",
    })

    expect(loading.steps.map((step) => [translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["Return to main checkout", "active"],
    ])

    const success = createWorkspaceTransitionSuccessProgress({ operation: "leave" })
    expect(translateProgressCopy(success.title)).toBe("Main checkout active")
    expect(translateProgressCopy(success.description)).toContain("main checkout")
    expect(success.steps.map((step) => [translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["Return to main checkout", "complete"],
    ])
  })

  test("creates new-session worktree startup steps for create and existing modes", () => {
    const i18n = englishI18n()
    const createProgress = createNewSessionWorkspaceProgress({ selection: { mode: "create" }, stage: "workspace" })
    expect(createProgress).toMatchObject({ kind: "new-worktree-session", phase: "loading" })
    expect(translateProgressCopy(createProgress.title)).toBe("Starting worktree session")
    expect(translateProgressCopy(createProgress.description)).toBe(
      "Preparing the workspace and submitting your first message.",
    )
    expect(createProgress.steps.map((step) => [translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["Prepare session", "complete"],
      ["Create checkout", "active"],
      ["Submit message", "pending"],
    ])

    const existingProgress = createNewSessionWorkspaceProgress({
      selection: { mode: "existing", target: "/repo/.synergy/worktrees/feature" },
      stage: "message",
    })
    expect(existingProgress.steps.map((step) => [translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["Prepare session", "complete"],
      ["Bind worktree", "complete"],
      ["Submit message", "active"],
    ])

    const createSuccess = createNewSessionWorkspaceSuccessProgress({ selection: { mode: "create" } })
    expect(createSuccess).toMatchObject({ kind: "new-worktree-session", phase: "success" })
    expect(translateProgressCopy(createSuccess.description)).toBe(
      "The workspace is ready and your first message is queued for processing.",
    )
    expect(createSuccess.steps.map((step) => [translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["Prepare session", "complete"],
      ["Create checkout", "complete"],
      ["Submit message", "complete"],
    ])

    const existingSuccess = createNewSessionWorkspaceSuccessProgress({
      selection: { mode: "existing", target: "/repo/.synergy/worktrees/feature" },
    })
    expect(existingSuccess.steps.map((step) => translateDescriptor(step.label, i18n))).toEqual([
      "Prepare session",
      "Bind worktree",
      "Submit message",
    ])

    expect(
      createNewSessionWorkspaceErrorProgress({ title: "Failed to prepare worktree", message: "Setup failed." }),
    ).toEqual({
      kind: "new-worktree-session",
      phase: "error",
      title: "Failed to prepare worktree",
      description: "Setup failed.",
      steps: [],
    })
  })

  test("recognizes only create and existing workspace selections as worktrees", () => {
    expect(isWorktreeWorkspaceSelection({ mode: "current" })).toBe(false)
    expect(isWorktreeWorkspaceSelection({ mode: "create" })).toBe(true)
    expect(isWorktreeWorkspaceSelection({ mode: "existing", target: "/repo/worktree" })).toBe(true)
  })

  test("maps worktree setup failure metadata to a user-facing failure message", () => {
    expect(worktreeSetupFailureMessage(undefined)).toBeUndefined()
    expect(worktreeSetupFailureMessage({ setupFailed: false, setupError: "ignored" })).toBeUndefined()
    expect(worktreeSetupFailureMessage({ setupFailed: true, setupError: " npm install failed " })).toBe(
      "npm install failed",
    )
    expect(worktreeSetupFailureMessage({ setupFailed: true })).toBe("Worktree setup command failed.")
  })
})
