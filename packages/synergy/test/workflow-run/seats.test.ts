import { describe, expect, test } from "bun:test"
import { WorkflowSeats } from "../../src/workflow-run/seats"
import { WorkflowTypes } from "../../src/workflow-run/types"

function charter(pool: number): WorkflowTypes.Charter {
  return WorkflowTypes.Charter.parse({
    id: "cht_test",
    version: 1,
    name: "T",
    entityType: "issue",
    entityInitialState: "queued",
    states: ["queued", WorkflowTypes.BLOCKED_STATE],
    seats: [{ name: "executor", agent: "synergy", charterPrompt: "x", pool, worktree: "none" }],
    transitions: [],
    gates: [],
    budget: { maxModelCalls: 0 },
    time: { created: Date.now() },
  })
}

function run(seats: WorkflowTypes.SeatBinding[], entities: WorkflowTypes.Entity[] = []): WorkflowTypes.Run {
  const now = Date.now()
  return {
    id: "wfr_1",
    scopeID: "s",
    charterRef: { id: "cht_test", version: 1 },
    title: "R",
    status: "active",
    bossSessionID: "ses_boss",
    seats,
    entities,
    gates: [],
    budget: { maxModelCalls: 0, used: 0 },
    time: { created: now, updated: now },
  }
}

describe("WorkflowSeats.initialBindings", () => {
  test("expands each seat into pool-many instances", () => {
    const bindings = WorkflowSeats.initialBindings(charter(3))
    expect(bindings).toHaveLength(3)
    expect(bindings.map((b) => b.instance)).toEqual([0, 1, 2])
    expect(bindings.every((b) => b.status === "unbound")).toBe(true)
  })
})

describe("WorkflowSeats.pickInstance", () => {
  test("returns undefined when the pool is fully occupied", () => {
    const r = run([
      { seat: "executor", instance: 0, status: "working", lastEntityIDs: [] },
      { seat: "executor", instance: 1, status: "working", lastEntityIDs: [] },
    ])
    expect(WorkflowSeats.pickInstance(r, charter(2), "executor")).toBeUndefined()
  })

  test("prefers an idle instance", () => {
    const r = run([
      { seat: "executor", instance: 0, status: "working", lastEntityIDs: [] },
      { seat: "executor", instance: 1, status: "idle", lastEntityIDs: [] },
    ])
    expect(WorkflowSeats.pickInstance(r, charter(2), "executor")).toBe(1)
  })

  test("prefers the instance with matching affinity", () => {
    const now = Date.now()
    const affineEntity: WorkflowTypes.Entity = {
      id: "wfe_prev",
      runID: "wfr_1",
      title: "prev",
      state: "done",
      bindings: {},
      submissions: [],
      affinityKey: "module-a",
      assignedSeat: { seat: "executor", instance: 1 },
      time: { created: now, updated: now, stateEntered: now },
    }
    const r = run(
      [
        { seat: "executor", instance: 0, status: "idle", lastEntityIDs: [] },
        { seat: "executor", instance: 1, status: "idle", lastEntityIDs: ["wfe_prev"] },
      ],
      [affineEntity],
    )
    expect(WorkflowSeats.pickInstance(r, charter(2), "executor", "module-a")).toBe(1)
  })
})
