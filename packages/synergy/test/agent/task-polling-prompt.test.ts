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
    // CORTEX_REMINDER still uses the exact literal
    expect(CORTEX_REMINDER).toContain(noPollingRule)
    expect(CORTEX_REMINDER).toContain(notificationRule)
    // TASK_DESCRIPTION now uses "do not poll" / "polling loop" language but same intent
    expect(TASK_DESCRIPTION).toMatch(/Do not poll|not.*polling loop/)
    expect(TASK_DESCRIPTION).toMatch(/wakes you automatically|wait for the automatic completion notification/)
  })

  test("completion notification is a lightweight wake-up, not the final result", () => {
    // Case-insensitive: text may use "does NOT" (CORTEX_REMINDER) or "do NOT" (synergy-max)
    const noResultInNotification = /(?:does|do) NOT contain the final result/i
    for (const prompt of [TASK_DESCRIPTION, CORTEX_REMINDER, buildSynergyPrompt([]), buildSynergyMaxPrompt([])]) {
      expect(prompt).toMatch(noResultInNotification)
    }
  })

  test("parent must retrieve result with task_output mode=full", () => {
    const retrieveWithFull = /task_output\(.*mode.*"full"\)/
    for (const prompt of [TASK_DESCRIPTION, CORTEX_REMINDER, buildSynergyPrompt([]), buildSynergyMaxPrompt([])]) {
      expect(prompt).toMatch(retrieveWithFull)
    }
  })

  test("full/default read acknowledges completion, diagnostic modes do not", () => {
    // Task description says diagnostic modes do NOT acknowledge
    // Case-insensitive to handle bold markers like **not**
    expect(TASK_DESCRIPTION).toMatch(/acknowledges the completion/i)
    expect(TASK_DESCRIPTION).toMatch(
      /do not acknowledge completion|do \*\*not\*\* acknowledge completion|not acknowledge completion/i,
    )
  })

  test("block=true is full-only", () => {
    // block=true is only valid with mode=full
    const blockFullOnly = /block.*true.*valid.*full|block.*true.*only.*full|block.*true.*full.*default/i
    expect(TASK_DESCRIPTION).toMatch(blockFullOnly)
  })

  test("diagnostic polling is explicitly prohibited", () => {
    // Explicit prohibition of polling loops
    const noPollingLoop = /do not poll|not.*polling loop|do not loop|no.*polling/i
    for (const prompt of [TASK_DESCRIPTION, CORTEX_REMINDER]) {
      expect(prompt).toMatch(noPollingLoop)
    }
  })

  test("agenda_watch and agenda_schedule are explicitly prohibited for subagent completion", () => {
    const noAgendaForSubagents = /Do NOT use.*agenda_watch|do not.*agenda_watch.*subagent|No watch.*is needed/i
    expect(TASK_DESCRIPTION).toMatch(noAgendaForSubagents)
  })
})
