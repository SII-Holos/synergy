import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { S } from "../../../src/components/session/session-i18n"
import {
  translateSessionTransitionCopy,
  type SessionTransitionProgress,
} from "../../../src/components/session/session-transition-progress"
import {
  createNewSessionWorkspaceAcceptedProgress,
  createNewSessionWorkspaceProgress,
  createNewSessionWorkspaceErrorProgress,
  createNewSessionWorkspaceSuccessProgress,
  createWorkspaceTransitionErrorProgress,
  createWorkspaceTransitionLoadingProgress,
  createWorkspaceTransitionRefreshErrorProgress,
  createWorkspaceTransitionRefreshProgress,
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

  test("does not implicitly reuse a previous worktree for a new task", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        currentDirectory: "/repo/.synergy/worktrees/feature",
        canonicalDirectory: "/repo",
      }),
    ).toEqual({ mode: "current" })
  })

  test("defaults to a new worktree when the persisted preference is worktree", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        currentDirectory: "/repo",
        canonicalDirectory: "/repo",
        preference: "worktree",
      }),
    ).toEqual({ mode: "create" })
  })

  test("keeps the main checkout default when the persisted preference is main", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        currentDirectory: "/repo",
        canonicalDirectory: "/repo",
        preference: "main",
      }),
    ).toEqual({ mode: "current" })
  })

  test("an explicit selection still wins over the persisted worktree preference", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        selected: { mode: "current" },
        currentDirectory: "/repo",
        canonicalDirectory: "/repo",
        preference: "worktree",
      }),
    ).toEqual({ mode: "current" })
  })

  test("a previous worktree does not override the project default", () => {
    expect(
      defaultNewSessionWorkspaceSelection({
        currentDirectory: "/repo/.synergy/worktrees/feature",
        canonicalDirectory: "/repo",
        preference: "main",
      }),
    ).toEqual({ mode: "current" })
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

  test("disables for busy and retry runtime statuses", () => {
    for (const status of [
      { type: "busy" },
      { type: "retry", attempt: 1, message: "rate limited", next: 100 },
    ] as const) {
      expect(isSessionRunningForWorkspaceChange({ status })).toBe(true)
    }
  })

  test("allows a session whose status is unknown", () => {
    expect(isSessionRunningForWorkspaceChange({ status: undefined })).toBe(false)
    expect(isSessionRunningForWorkspaceChange({})).toBe(false)
  })

  test("disables for session working metadata", () => {
    expect(isSessionRunningForWorkspaceChange({ working: { status: "busy" }, status: { type: "idle" } })).toBe(true)
  })

  test("allows idle sessions without local pending state", () => {
    expect(isSessionRunningForWorkspaceChange({ status: { type: "idle" } })).toBe(false)
  })
})

describe("workspace transition progress model", () => {
  test("reports enter and leave operations through current workspace activity", () => {
    for (const operation of ["enter", "leave"] as const) {
      const loading = createWorkspaceTransitionLoadingProgress({ operation, sessionID: "ses_1", directory: "/repo" })
      expect(loading).toMatchObject({
        phase: "loading",
        kind: `${operation}-worktree`,
        activity: { phase: "preparing_workspace", workspaceOperation: operation },
      })
      expect(createWorkspaceTransitionSuccessProgress({ operation })).toEqual({
        kind: `${operation}-worktree`,
        phase: "success",
      })
    }
    const failed = createWorkspaceTransitionErrorProgress({ operation: "enter", message: "Failed" })
    expect(failed).toMatchObject({ phase: "error", kind: "enter-worktree", description: "Failed" })
    expect(translateProgressCopy(failed.title)).toBe("Could not use the Worktree")
  })

  test("retains actionable errors when location refresh fails", () => {
    expect(createWorkspaceTransitionRefreshProgress({ operation: "enter" }).activity?.phase).toBe("preparing_workspace")
    const failed = createWorkspaceTransitionRefreshErrorProgress({ operation: "enter", message: "Network error" })
    expect(translateProgressCopy(failed.title)).toBe("Could not refresh file location")
    expect(translateProgressCopy(failed.description)).toContain("location changed")
    expect(translateProgressCopy(failed.description)).toContain("Network error")
  })

  test("distinguishes creating and binding a worktree, then advances to submission", () => {
    for (const selection of [{ mode: "create" }, { mode: "existing", target: "/repo/worktree" }] as const) {
      const preparing = createNewSessionWorkspaceProgress({ selection, stage: "workspace" })
      expect(preparing).toMatchObject({
        kind: "new-worktree-session",
        phase: "loading",
        activity: { phase: "preparing_workspace", workspaceOperation: selection.mode === "create" ? "create" : "bind" },
      })
      expect(createNewSessionWorkspaceProgress({ selection, stage: "message" }).activity?.phase).toBe(
        "submitting_input",
      )
      expect(createNewSessionWorkspaceAcceptedProgress({ selection }).activity?.phase).toBe("materializing_input")
      expect(createNewSessionWorkspaceSuccessProgress({ selection })).toEqual({
        kind: "new-worktree-session",
        phase: "success",
      })
    }
    expect(
      createNewSessionWorkspaceErrorProgress({ title: "Failed to prepare worktree", message: "Setup failed." }),
    ).toEqual({
      kind: "new-worktree-session",
      phase: "error",
      title: "Failed to prepare worktree",
      description: "Setup failed.",
      dismissLabel: S.submissionRestoreDraft,
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
