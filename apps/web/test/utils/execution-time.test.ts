import { expect, test } from "bun:test"
import { ExecutionClock, newerExecutionSample } from "../../src/utils/execution-time"

test("execution time advances on the local monotonic clock and freezes until a new snapshot", () => {
  const clock = new ExecutionClock()
  clock.accept(10)
  expect(clock.advance(1010)).toBe(1000)
  clock.pause(1510)
  expect(clock.advance(9010)).toBe(1500)
  clock.accept(10010)
  expect(clock.advance(11010)).toBe(1000)
})
test("old events cannot revive a completed task, and only a snapshot admits a new server instance", () => {
  const current = { clockID: "a", sampledAt: 100, revision: 2 }
  expect(newerExecutionSample(current, { ...current, revision: 1, sampledAt: 200 })).toBe(false)
  expect(newerExecutionSample(current, { ...current, sampledAt: 90 })).toBe(false)
  expect(newerExecutionSample(current, { clockID: "b", sampledAt: 0, revision: 1 })).toBe(false)
  expect(newerExecutionSample(current, { clockID: "b", sampledAt: 0, revision: 1 }, true)).toBe(true)
})

test("a fresh snapshot received while disconnected replaces the frozen baseline without extrapolating", () => {
  const clock = new ExecutionClock()
  clock.accept(0)
  clock.pause(1000)
  clock.accept(2000, false)
  expect(clock.advance(9000)).toBe(0)
  clock.accept(10000)
  expect(clock.advance(11000)).toBe(1000)
})
