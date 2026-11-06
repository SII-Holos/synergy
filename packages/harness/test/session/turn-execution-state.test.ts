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

test("a terminal reply stops foreground activity while background accounting stays open", () => {
  const value = TurnExecutionState.project(
    { id: "root", status: "running", started: 100 },
    [{ id: "segment", status: "completed", started: 120, ended: 1_110 }],
    false,
    { completedAt: 1_100, failed: false },
  )
  expect(value).toMatchObject({ status: "completed", endedAt: 1_100 })
  expect(value).not.toHaveProperty("elapsedMs")
})

test("background settlement cannot extend the foreground completion boundary", () => {
  const value = TurnExecutionState.project(
    { id: "root", status: "completed", started: 100, ended: 6_000 },
    [{ id: "segment", status: "completed", started: 120, ended: 1_110 }],
    false,
    { completedAt: 1_100, failed: false },
  )
  expect(value).toMatchObject({ status: "completed", endedAt: 1_100 })
  expect(value).not.toHaveProperty("elapsedMs")
})

test("an earlier reply cannot settle a resumed or still active execution", () => {
  const reply = { completedAt: 1_100, failed: false }
  for (const segment of [
    { id: "active", status: "running" as const, started: 120 },
    { id: "resumed", status: "completed" as const, started: 2_000, ended: 3_000 },
  ]) {
    const value = TurnExecutionState.project({ id: "root", status: "running", started: 100 }, [segment], false, reply)
    expect(value.status).toBe("running")
    expect(value).not.toHaveProperty("elapsedMs")
  }
})

test("reply completion preserves failures, approvals and interruptions", () => {
  const running = { id: "root", status: "running", started: 100 } as const
  const segments = [{ id: "segment", status: "completed", started: 120, ended: 1_110 }] as const
  const reply = { completedAt: 1_100, failed: true }
  expect(TurnExecutionState.project(running, [...segments], false, reply).status).toBe("failed")
  expect(TurnExecutionState.project(running, [...segments], true, reply).status).toBe("approval")
  for (const status of ["cancelled", "interrupted"] as const) {
    const state = TurnExecutionState.project({ ...running, status, ended: 1_200 }, [...segments], false, reply)
    expect(state).toMatchObject({ status: status === "cancelled" ? "stopped" : "interrupted", endedAt: 1_200 })
    expect(state).not.toHaveProperty("elapsedMs")
  }
})
