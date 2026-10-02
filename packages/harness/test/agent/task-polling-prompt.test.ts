import { describe, expect, test } from "bun:test"
import { buildCodingPrompt } from "../../src/agent/prompt/coding/builder"
import { buildGeneralPrompt } from "../../src/agent/prompt/general/builder"
import CORTEX_REMINDER from "../../src/session/prompt/cortex-reminder.txt"
import TASK_DESCRIPTION from "../../src/cortex/tools/task.txt"

const noPollingRule = "Do not repeatedly call `task_output` while a task is running."
const notificationRule = "wait for the automatic completion notification"

describe("primary process waiting guidance", () => {
  for (const [name, prompt] of [
    ["general", buildGeneralPrompt()],
    ["coding", buildCodingPrompt()],
  ]) {
    test(`${name} chooses waits from dependencies and available work`, () => {
      expect(prompt).toMatch(/continue independent work while a command runs/i)
      expect(prompt).toMatch(/wait when completion gates progress and no independent work remains/i)
      expect(prompt).toMatch(/persistent services, check readiness rather than waiting for exit/i)
    })

    test(`${name} diagnoses from evidence without treating silence or a wait window as failure`, () => {
      expect(prompt).toMatch(/Running does not prove progress/i)
      expect(prompt).toMatch(/Diagnose an explicit input request or unexplained lack of progress/i)
      expect(prompt).toMatch(/confirmed quiet work can keep running/i)
      expect(prompt).toMatch(/known, authorized inputs for unattended work/i)
      expect(prompt).toMatch(/Do not manufacture progress by repeatedly checking status or rerunning a command/i)
      expect(prompt).toMatch(/do not treat a wait window ending as failure/i)
    })
  }
})

describe("background task polling guidance", () => {
  test("primary agent prompts prefer automatic completion notifications", () => {
    for (const prompt of [buildGeneralPrompt(), buildCodingPrompt()]) {
      expect(prompt).toContain(noPollingRule)
      expect(prompt).toContain(notificationRule)
    }
  })

  test("task guidance reserves progress checks for one-shot diagnostics", () => {
    expect(CORTEX_REMINDER).toContain(noPollingRule)
    expect(CORTEX_REMINDER).toContain(notificationRule)
    expect(TASK_DESCRIPTION).toMatch(/Do not poll|not.*polling loop/)
    expect(TASK_DESCRIPTION).toMatch(/wakes you automatically|wait for the automatic completion notification/)
  })

  test("completion notification is a lightweight wake-up, not the final result", () => {
    const noResultInNotification = /(?:does|do) NOT contain the final result/i
    for (const prompt of [TASK_DESCRIPTION, CORTEX_REMINDER, buildGeneralPrompt(), buildCodingPrompt()]) {
      expect(prompt).toMatch(noResultInNotification)
    }
  })

  test("parent must retrieve result with task_output mode=full", () => {
    const retrieveWithFull = /task_output\(.*mode.*"full"\)/
    for (const prompt of [TASK_DESCRIPTION, CORTEX_REMINDER, buildGeneralPrompt(), buildCodingPrompt()]) {
      expect(prompt).toMatch(retrieveWithFull)
    }
  })

  test("full/default read acknowledges completion, diagnostic modes do not", () => {
    expect(TASK_DESCRIPTION).toMatch(/acknowledges the completion/i)
    expect(TASK_DESCRIPTION).toMatch(
      /do not acknowledge completion|do \*\*not\*\* acknowledge completion|not acknowledge completion/i,
    )
  })

  test("block=true is full-only", () => {
    const blockFullOnly = /block.*true.*valid.*full|block.*true.*only.*full|block.*true.*full.*default/i
    expect(TASK_DESCRIPTION).toMatch(blockFullOnly)
  })

  test("agenda_watch and agenda_schedule are explicitly prohibited for subagent completion", () => {
    const noAgendaForSubagents = /Do NOT use.*agenda_watch|do not.*agenda_watch.*subagent|No watch.*is needed/i
    expect(TASK_DESCRIPTION).toMatch(noAgendaForSubagents)
  })
})
