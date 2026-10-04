import { expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { sessionActivityLabel } from "../src/components/session-status"

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
