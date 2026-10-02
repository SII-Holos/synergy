import { expect, test } from "bun:test"
import { TurnExecutionState } from "../../src/session/turn-execution-state"

const run = { id: "root-a", status: "cancelled", started: 10, ended: 20 } as const

test("historical cancellation survives another root completing", () => {
  expect(TurnExecutionState.project(run, [], false).status).toBe("stopped")
})

test("resumed execution keeps previous stop evidence", () => {
  const value = TurnExecutionState.project({ ...run, status: "running", ended: undefined }, [
    { id: "first", status: "cancelled", started: 10, ended: 20 },
    { id: "next", status: "running", started: 30 },
  ])
  expect(value.status).toBe("running")
  expect(value.stoppedAt).toEqual([20])
  expect(value.segmentID).toBe("next")
})

test("approval applies only to its owning root", () => {
  expect(TurnExecutionState.project({ ...run, status: "running" }, [], true).status).toBe("approval")
  expect(TurnExecutionState.project({ ...run, status: "completed" }, []).status).toBe("completed")
})
