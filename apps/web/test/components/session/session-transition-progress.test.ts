import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import {
  createNewSessionTransitionAcceptedProgress,
  createNewSessionTransitionErrorProgress,
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
  createSessionPreparationProgress,
  createSessionTransitionHandoffErrorProgress,
  isSessionTransitionBlocking,
  translateSessionTransitionCopy,
} from "../../../src/components/session/session-transition-progress"

describe("session submission progress", () => {
  test("reports the current preparation, submission and execution stage", () => {
    expect(createSessionPreparationProgress().activity?.phase).toBe("checking_submission")
    const submitting = createNewSessionTransitionProgress()
    expect(submitting).toMatchObject({ kind: "new-session", phase: "loading", activity: { phase: "submitting_input" } })
    expect(submitting.activity?.startedAt).toBeGreaterThan(0)
    expect(createNewSessionTransitionAcceptedProgress().activity?.phase).toBe("materializing_input")
    expect(isSessionTransitionBlocking(submitting)).toBe(true)
    expect(isSessionTransitionBlocking(createNewSessionTransitionSuccessProgress())).toBe(false)
  })

  test("keeps recoverable failures and structured diagnostics", () => {
    const failed = createSessionTransitionHandoffErrorProgress({
      kind: "new-session",
      error: { code: "ModelUnavailable", message: "Select a configured model" },
    })
    expect(failed.phase).toBe("error")
    expect(failed.activity).toBeUndefined()
    expect(failed.error).toEqual({ code: "ModelUnavailable", message: "Select a configured model" })
    expect(isSessionTransitionBlocking(failed)).toBe(true)
    expect(failed.retryLabel).toBeDefined()
  })

  test("translates failure copy reactively and preserves raw diagnostics", () => {
    const failed = createSessionTransitionHandoffErrorProgress({ kind: "new-session" })
    const i18n = setupI18n({
      locale: "en",
      messages: {
        en: {},
        "zh-CN": {
          "session.submission.startFailed": "无法开始执行",
          "session.submission.savedFailure": "消息已保存，请重试。",
        },
      },
    })
    expect(translateSessionTransitionCopy(failed.title, i18n)).toBe("Unable to start execution")
    i18n.activate("zh-CN")
    expect(translateSessionTransitionCopy(failed.title, i18n)).toBe("无法开始执行")
    expect(translateSessionTransitionCopy(failed.description, i18n)).toBe("消息已保存，请重试。")
    const raw = createNewSessionTransitionErrorProgress({ title: "Provider failed", message: "Connection closed." })
    expect(translateSessionTransitionCopy(raw.title, i18n)).toBe("Provider failed")
    expect(translateSessionTransitionCopy(raw.description, i18n)).toBe("Connection closed.")
  })
})
