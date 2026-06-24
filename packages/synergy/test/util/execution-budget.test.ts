import { describe, expect, test } from "bun:test"
import { ExecutionBudget } from "../../src/util/execution-budget"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("ExecutionBudget", () => {
  test("pauses timeout while approval is pending", async () => {
    const budget = ExecutionBudget.create(80)
    budget.pause()
    await sleep(120)
    expect(budget.signal.aborted).toBe(false)

    budget.resume()
    await sleep(30)
    expect(budget.signal.aborted).toBe(false)

    await sleep(70)
    expect(budget.signal.aborted).toBe(true)
    budget.dispose()
  })

  test("dispose clears the active timeout", async () => {
    const budget = ExecutionBudget.create(20)
    budget.dispose()
    await sleep(40)
    expect(budget.signal.aborted).toBe(false)
  })
})
