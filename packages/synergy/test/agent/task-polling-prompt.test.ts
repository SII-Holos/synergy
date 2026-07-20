import { describe, expect, test } from "bun:test"
import { buildSynergyMaxPrompt } from "../../src/agent/prompt/synergy-max/builder"
import { buildSynergyPrompt } from "../../src/agent/prompt/synergy/builder"
import CORTEX_REMINDER from "../../src/session/prompt/cortex-reminder.txt"
import TASK_DESCRIPTION from "../../src/tool/task.txt"

const noPollingRule = "Do not repeatedly call `task_output` while a task is running."
const notificationRule = "wait for the automatic completion notification"

describe("background task polling guidance", () => {
  test("primary agent prompts prefer automatic completion notifications", () => {
    for (const prompt of [buildSynergyPrompt([]), buildSynergyMaxPrompt([])]) {
      expect(prompt).toContain(noPollingRule)
      expect(prompt).toContain(notificationRule)
    }
  })

  test("task guidance reserves progress checks for one-shot diagnostics", () => {
    for (const prompt of [TASK_DESCRIPTION, CORTEX_REMINDER]) {
      expect(prompt).toContain(noPollingRule)
      expect(prompt).toContain(notificationRule)
    }
  })
})
