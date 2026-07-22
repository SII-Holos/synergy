import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { translateDescriptor } from "@/locales/translate"
import { S } from "../../../src/components/session/session-i18n"
import {
  createNewSessionTransitionErrorProgress,
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
  createSessionStartupSteps,
  isSessionTransitionBlocking,
  sessionTransitionPresentation,
  translateSessionTransitionCopy,
  type SessionTransitionKind,
  type SessionTransitionProgress,
} from "../../../src/components/session/session-transition-progress"

function progress(kind: SessionTransitionKind, phase: SessionTransitionProgress["phase"]): SessionTransitionProgress {
  return {
    kind,
    phase,
    title: "Title",
    description: "Description",
    steps: [],
  }
}

function englishI18n() {
  const i18n = setupI18n({ locale: "en" })
  i18n.loadAndActivate({
    locale: "en",
    messages: Object.fromEntries(Object.values(S).map((descriptor) => [descriptor.id, descriptor.message])),
  })
  return i18n
}

describe("session transition progress model", () => {
  test("models ordinary new-session acceptance and persistent errors", () => {
    const i18n = englishI18n()
    const loading = createNewSessionTransitionProgress()
    expect(loading).toMatchObject({ kind: "new-session", phase: "loading" })
    expect(translateSessionTransitionCopy(loading.title, i18n)).toBe("Starting session")
    expect(translateSessionTransitionCopy(loading.description, i18n)).toBe("Submitting your first message.")
    expect(loading.steps.map((step) => [step.id, translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["session", "Prepare session", "complete"],
      ["message", "Submit message", "active"],
    ])

    const success = createNewSessionTransitionSuccessProgress()
    expect(success).toMatchObject({ kind: "new-session", phase: "success" })
    expect(translateSessionTransitionCopy(success.title, i18n)).toBe("Session request accepted")
    expect(translateSessionTransitionCopy(success.description, i18n)).toBe(
      "Your first message is queued for processing.",
    )
    expect(success.steps.map((step) => [step.id, translateDescriptor(step.label, i18n), step.state])).toEqual([
      ["session", "Prepare session", "complete"],
      ["message", "Submit message", "complete"],
    ])

    const error = createNewSessionTransitionErrorProgress({
      title: "Failed to send prompt",
      message: "Connection closed.",
    })
    expect(error).toEqual({
      kind: "new-session",
      phase: "error",
      title: "Failed to send prompt",
      description: "Connection closed.",
      steps: [],
    })
    expect(isSessionTransitionBlocking(loading)).toBe(true)
    expect(isSessionTransitionBlocking(error)).toBe(true)
    expect(isSessionTransitionBlocking(success)).toBe(false)
  })

  test("shares startup step ordering across ordinary and worktree sessions", () => {
    const workspace = {
      label: { id: "test.session.workspace.label", message: "Create checkout" },
      activeDetail: { id: "test.session.workspace.active", message: "Preparing a new git worktree." },
      completeDetail: { id: "test.session.workspace.complete", message: "Workspace setup complete." },
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
    const i18n = englishI18n()
    const expected = [
      ["new-session", "session.new", "New session"],
      ["new-worktree-session", "workspace.worktree", "Worktree session"],
      ["enter-worktree", "workspace.enterWorktree", "Session worktree"],
      ["leave-worktree", "workspace.leaveWorktree", "Main checkout"],
    ] as const

    for (const [kind, icon, kicker] of expected) {
      const presentation = sessionTransitionPresentation(progress(kind, "loading"))
      expect(presentation.icon).toBe(getSemanticIcon(icon))
      expect(translateDescriptor(presentation.kicker, i18n)).toBe(kicker)
      expect(sessionTransitionPresentation(progress(kind, "success")).icon).toBe(getSemanticIcon("state.success"))
      expect(sessionTransitionPresentation(progress(kind, "error")).icon).toBe(getSemanticIcon("state.error"))
    }
  })

  test("re-resolves stored descriptors after the active locale changes", () => {
    const progress = createNewSessionTransitionProgress()
    const i18n = englishI18n()
    expect(translateSessionTransitionCopy(progress.title, i18n)).toBe("Starting session")

    i18n.loadAndActivate({
      locale: "zh-CN",
      messages: {
        [S.transitionTitleStarting.id]: "正在启动会话",
        [S.transitionStepSubmitMessage.id]: "提交消息",
      },
    })

    expect(translateSessionTransitionCopy(progress.title, i18n)).toBe("正在启动会话")
    expect(translateDescriptor(progress.steps[1]!.label, i18n)).toBe("提交消息")
    const raw = createNewSessionTransitionErrorProgress({ title: "Provider failed", message: "Connection closed." })
    expect(translateSessionTransitionCopy(raw.title, i18n)).toBe("Provider failed")
  })
})
