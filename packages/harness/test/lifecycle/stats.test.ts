import { expect, test } from "bun:test"
import { readRuntimeStats } from "../../src/lifecycle/stats"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("runtime tool stats are immutable detached snapshots", () =>
  runtime.run(() => {
    const first = readRuntimeStats()
    expect(first.toolTasks.active).toBeGreaterThanOrEqual(0)
    expect(first.toolTasks.maxConcurrent).toBeGreaterThan(0)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.toolTasks)).toBe(true)
    expect(Object.isFrozen(first.toolTasks.byExecutor)).toBe(true)
    const second = readRuntimeStats()
    expect(first).not.toBe(second)
    expect(first.toolTasks.byExecutor).not.toBe(second.toolTasks.byExecutor)
  }))

afterRuntimeTests(() => runtime.close())
