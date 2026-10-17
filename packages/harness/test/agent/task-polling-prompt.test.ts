import { describe, expect, test } from "bun:test"
import CORTEX_REMINDER from "../../src/session/prompt/cortex-reminder.txt"
import TASK_DESCRIPTION from "../../src/cortex/tools/task.txt"

describe("background task guidance", () => {
  test("running reminder supplies task state without a calling tutorial", () => {
    expect(CORTEX_REMINDER).toContain("{{count}}")
    expect(CORTEX_REMINDER).toContain("{{task_list}}")
    expect(CORTEX_REMINDER).toMatch(/already delegated.*independent work.*without duplicating.*integrate/s)
    expect(CORTEX_REMINDER).not.toMatch(/task_output\(|task_list\(|mode=/)
  })

  test("task description reserves progress checks for one-shot diagnostics", () => {
    expect(TASK_DESCRIPTION).toMatch(/do not poll\/loop for progress/i)
    expect(TASK_DESCRIPTION).toMatch(/Completion automatically wakes you/)
  })

  test("completion notification is a lightweight wake-up, not the final result", () => {
    expect(TASK_DESCRIPTION).toMatch(/notification, not the final result/i)
    expect(TASK_DESCRIPTION).toMatch(/task_output\(.*mode.*"full"\)/)
  })

  test("full/default read acknowledges completion, diagnostic modes do not", () => {
    expect(TASK_DESCRIPTION).toMatch(
      /Full\/default output acknowledges and clears the notification; diagnostic modes do not/i,
    )
  })

  test("block=true is full-only", () => {
    expect(TASK_DESCRIPTION).toMatch(/block.*true.*valid.*full|block.*true.*only.*full|block.*true.*full.*default/i)
  })

  test("automatic completion notifications do not require a scheduler product", () => {
    expect(TASK_DESCRIPTION).toMatch(/Do not schedule extra completion wake-ups/i)
    expect(TASK_DESCRIPTION).not.toMatch(/agenda_\w+/)
  })
})
