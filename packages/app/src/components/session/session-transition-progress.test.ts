import { describe, expect, test } from "bun:test"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import {
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
  createSessionStartupSteps,
  sessionTransitionPresentation,
  type SessionTransitionKind,
  type SessionTransitionProgress,
} from "./session-transition-progress"

function progress(kind: SessionTransitionKind, phase: SessionTransitionProgress["phase"]): SessionTransitionProgress {
  return {
    kind,
    phase,
    title: "Title",
    description: "Description",
    steps: [],
  }
}

describe("session transition progress model", () => {
  test("creates ordinary new-session loading and success steps", () => {
    const loading = createNewSessionTransitionProgress()
    expect(loading).toMatchObject({
      kind: "new-session",
      phase: "loading",
      title: "Starting session",
      description: "Sending your first message.",
    })
    expect(loading.steps.map((step) => [step.id, step.label, step.state])).toEqual([
      ["session", "Prepare session", "complete"],
      ["message", "Send message", "active"],
    ])

    const success = createNewSessionTransitionSuccessProgress()
    expect(success).toMatchObject({
      kind: "new-session",
      phase: "success",
      title: "Session started",
      description: "Your first message was sent.",
    })
    expect(success.steps.map((step) => [step.id, step.label, step.state])).toEqual([
      ["session", "Prepare session", "complete"],
      ["message", "Send message", "complete"],
    ])
  })

  test("shares startup step ordering across ordinary and worktree sessions", () => {
    const workspace = {
      label: "Create checkout",
      activeDetail: "Preparing a new git worktree.",
      completeDetail: "Workspace setup complete.",
    }

    expect(createSessionStartupSteps({ stage: "workspace", workspace }).map((step) => [step.id, step.state])).toEqual([
      ["session", "complete"],
      ["workspace", "active"],
      ["message", "pending"],
    ])
    expect(createSessionStartupSteps({ stage: "message", workspace }).map((step) => [step.id, step.state])).toEqual([
      ["session", "complete"],
      ["workspace", "complete"],
      ["message", "active"],
    ])
    expect(createSessionStartupSteps({ stage: "complete", workspace }).map((step) => [step.id, step.state])).toEqual([
      ["session", "complete"],
      ["workspace", "complete"],
      ["message", "complete"],
    ])
  })

  test("maps every transition kind and terminal phase to semantic presentation", () => {
    const expected = [
      ["new-session", "session.new", "New session"],
      ["new-worktree-session", "workspace.worktree", "Worktree session"],
      ["enter-worktree", "workspace.enterWorktree", "Session worktree"],
      ["leave-worktree", "workspace.leaveWorktree", "Main checkout"],
    ] as const

    for (const [kind, icon, kicker] of expected) {
      expect(sessionTransitionPresentation(progress(kind, "loading"))).toEqual({
        icon: getSemanticIcon(icon),
        kicker,
      })
      expect(sessionTransitionPresentation(progress(kind, "success")).icon).toBe(getSemanticIcon("state.success"))
      expect(sessionTransitionPresentation(progress(kind, "error")).icon).toBe(getSemanticIcon("state.error"))
    }
  })
})
