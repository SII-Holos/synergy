import { expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { sessionActivityAnimating, sessionActivityLabel } from "../src/components/session-status"

test("current activity is localized without deriving it from loaded tool parts or diagnostic descriptions", () => {
  const i18n = setupI18n({
    locale: "en",
    messages: {
      en: {},
      "zh-CN": {
        "session.activity.preparingFiles": "正在准备项目文件",
        "session.activity.processing": "正在处理任务",
        "session.activity.parallelTools": "正在调用工具 · {count} 项",
      },
    },
  })
  expect(sessionActivityLabel({ type: "busy", description: "Awaiting response…" }, i18n)).toBe("Processing task")
  expect(sessionActivityLabel({ type: "busy", activity: { phase: "waiting_model", startedAt: 1 } }, i18n)).toBe(
    "Waiting for model response",
  )
  i18n.activate("zh-CN")
  expect(sessionActivityLabel({ type: "busy", activity: { phase: "preparing_files", startedAt: 1 } }, i18n)).toBe(
    "正在准备项目文件",
  )
  expect(
    sessionActivityLabel(
      { type: "busy", activity: { phase: "running_tools", startedAt: 1, tool: { id: "read", count: 3 } } },
      i18n,
    ),
  ).toBe("正在调用工具 · 3 项")
  expect(sessionActivityLabel({ type: "busy", description: "working..." }, i18n)).toBe("正在处理任务")
})

test("activity motion requires current runtime evidence and stops for human or transport waits", () => {
  const status = { type: "busy" as const, activity: { phase: "waiting_model" as const, startedAt: 1, rootID: "root" } }
  expect(sessionActivityAnimating(status, { rootID: "root" })).toBe(true)
  for (const context of [{ rootID: "other" }, { connected: false }, { approval: true }, { question: true }]) {
    expect(sessionActivityAnimating(status, context)).toBe(false)
  }
  expect(sessionActivityLabel(status, undefined, { connected: false })).toBe("Reconnecting")
  expect(sessionActivityAnimating({ type: "busy", description: "working" })).toBe(false)
  expect(
    sessionActivityAnimating({
      type: "retry",
      rootID: "retry-root",
      messageID: "retry-message",
      phase: "waiting",
      error: "rate limited",
      startedAt: 0,
      canRetry: true,
      attempt: 1,
      message: "retry",
      next: 1,
    }),
  ).toBe(false)
  for (const phase of ["stopping", "reconnecting"] as const) {
    expect(sessionActivityAnimating({ type: "busy", activity: { phase, startedAt: 1 } })).toBe(false)
  }
})

test("an ID-only Blueprint activity does not guess whether the executor is reviewing or pausing", () => {
  const status = {
    type: "busy" as const,
    activity: { phase: "running_tools" as const, startedAt: 1, tool: { id: "blueprint_loop_stop", count: 1 } },
  }
  expect(sessionActivityLabel(status)).toBe("Calling tool · Blueprint action")
  const i18n = setupI18n({
    locale: "zh-CN",
    messages: {
      "zh-CN": { "session.activity.tool": "正在调用工具 · {action}", "session.activity.blueprintAction": "蓝图操作" },
    },
  })
  expect(sessionActivityLabel(status, i18n)).toBe("正在调用工具 · 蓝图操作")
})

test("each retry phase names only what its own wait can honour", () => {
  const retry = (phase: Extract<SessionStatus, { type: "retry" }>["phase"]): SessionStatus => ({
    type: "retry",
    rootID: "root",
    messageID: "message",
    phase,
    attempt: 2,
    message: "rate limited",
    error: "rate limited",
    startedAt: 1,
    canRetry: true,
  })

  // Local backoff is the only phase that owns a deadline, so it is the only one
  // that reports an attempt number.
  expect(sessionActivityLabel(retry("waiting"))).toBe("Waiting to retry · attempt 2")
  expect(sessionActivityLabel(retry("waiting_provider"))).toBe("Waiting for model connection recovery")
  expect(sessionActivityLabel(retry("connecting"))).toBe("Waiting for model response")

  const i18n = setupI18n({
    locale: "zh-CN",
    messages: {
      "zh-CN": {
        "session.activity.retry": "等待重试 · 第 {attempt} 次",
        "session.activity.retryProvider": "等待模型连接恢复",
        "session.activity.waitingModel": "等待模型回复",
      },
    },
  })
  expect(sessionActivityLabel(retry("waiting"), i18n)).toBe("等待重试 · 第 2 次")
  expect(sessionActivityLabel(retry("waiting_provider"), i18n)).toBe("等待模型连接恢复")
  expect(sessionActivityLabel(retry("connecting"), i18n)).toBe("等待模型回复")
})
