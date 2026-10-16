import { describe, expect, test } from "bun:test"
import TASK_DESCRIPTION from "../../src/cortex/tools/task.txt"

describe("task delegation guidance", () => {
  test("parallelism is preserved for independent, ready work only", () => {
    expect(TASK_DESCRIPTION).toMatch(
      /Launch independent tasks concurrently only when inputs and write\/resource ownership allow it/i,
    )
    expect(TASK_DESCRIPTION).toMatch(/continue independent parent work/i)
    expect(TASK_DESCRIPTION).not.toMatch(/parallelize across multiple agents/i)
    expect(TASK_DESCRIPTION).toMatch(/independent ready work/i)
  })

  test("assignments are scoped around one coherent, independently verifiable deliverable", () => {
    expect(TASK_DESCRIPTION).toMatch(/one coherent, independently verifiable deliverable/i)
    expect(TASK_DESCRIPTION).toMatch(/do not bundle separately decidable goals/i)
    expect(TASK_DESCRIPTION).toMatch(/or split tightly coupled work merely by file, duration or step count/i)
  })

  test("dependencies gate dependent tasks without serializing unrelated ready work", () => {
    expect(TASK_DESCRIPTION).toMatch(/Wait for prerequisites before dependent work/i)
    expect(TASK_DESCRIPTION).toMatch(/Launch independent tasks concurrently/i)
  })

  test("parent composes the handoff and owns decomposition, integration, and acceptance", () => {
    expect(TASK_DESCRIPTION).toMatch(
      /Include goal, settled decisions, evidence, scope, deliverable, verification and escalation conditions/i,
    )
    expect(TASK_DESCRIPTION).toMatch(/parent owns decomposition, integration and acceptance, not the user/i)
  })

  test("material design decisions precede dependent implementation or become bounded investigation", () => {
    expect(TASK_DESCRIPTION).toMatch(/Resolve design decisions before dependent implementation/i)
    expect(TASK_DESCRIPTION).toMatch(/or assign a bounded investigation explicitly/i)
  })
})
