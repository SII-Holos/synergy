import { describe, expect, test } from "bun:test"
import TASK_DESCRIPTION from "../../src/cortex/tools/task.txt"

describe("task delegation guidance", () => {
  test("parallelism is preserved for independent, ready work only", () => {
    expect(TASK_DESCRIPTION).toMatch(/Launch independent tasks concurrently when their inputs are ready/i)
    expect(TASK_DESCRIPTION).toMatch(/continue useful independent parent work/i)
  })

  test("assignments are scoped around one coherent, independently verifiable deliverable", () => {
    expect(TASK_DESCRIPTION).toMatch(/one coherent, independently verifiable deliverable/i)
    expect(TASK_DESCRIPTION).toMatch(/do not bundle separately decidable goals/i)
    expect(TASK_DESCRIPTION).toMatch(/do not split tightly coupled work by file, step count, or duration/i)
  })

  test("dependencies gate dependent tasks without serializing unrelated ready work", () => {
    expect(TASK_DESCRIPTION).toMatch(/Start dependent tasks after the inputs they need exist/i)
    expect(TASK_DESCRIPTION).toMatch(/do not serialize unrelated ready work/i)
  })

  test("parent composes the handoff and owns decomposition, integration, and acceptance", () => {
    expect(TASK_DESCRIPTION).toMatch(/The parent composes the handoff/i)
    expect(TASK_DESCRIPTION).toMatch(/owns decomposition, integration, and acceptance/i)
    expect(TASK_DESCRIPTION).toMatch(/Do not ask the user to write a task contract/i)
  })

  test("material design decisions precede dependent implementation or become bounded investigation", () => {
    expect(TASK_DESCRIPTION).toMatch(/Resolve material design decisions before dispatching dependent implementation/i)
    expect(TASK_DESCRIPTION).toMatch(/delegate a clearly bounded investigation first/i)
    expect(TASK_DESCRIPTION).toMatch(/State clearly whether the agent should implement or investigate/i)
    expect(TASK_DESCRIPTION).toMatch(/Do not disguise an open-ended planning problem as an implementation task/i)
  })

  test("review examples distinguish an existing boundary from review of new implementation", () => {
    expect(TASK_DESCRIPTION).toMatch(/Reviewing an existing trust boundary is independent of unrelated implementation/i)
    expect(TASK_DESCRIPTION).toMatch(
      /Review of new implementation waits until the implementation produces a reviewable artifact/i,
    )
  })
})
