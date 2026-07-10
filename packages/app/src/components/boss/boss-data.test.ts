import { describe, expect, test } from "bun:test"
import type { WorkflowRun, WorkflowEvent } from "@ericsanchezok/synergy-sdk/client"
import { BossData } from "./boss-data"

function event(id: string, created: number, kind: WorkflowEvent["kind"] = "entity_added"): WorkflowEvent {
  return { id, runID: "wfr_1", scopeID: "s", kind, time: { created } }
}

function run(entities: { state: string; id: string }[]): WorkflowRun {
  return {
    id: "wfr_1",
    scopeID: "s",
    charterRef: { id: "cht_1", version: 1 },
    title: "R",
    status: "active",
    bossSessionID: "ses_boss",
    seats: [],
    entities: entities.map((e) => ({
      id: e.id,
      runID: "wfr_1",
      title: e.id,
      state: e.state,
      bindings: {},
      submissions: [],
      time: { created: 0, updated: 0, stateEntered: 0 },
    })),
    gates: [],
    budget: { maxModelCalls: 0, used: 0 },
    time: { created: 0, updated: 0 },
  }
}

describe("BossData.mergeEvents", () => {
  test("de-duplicates by id and sorts chronologically", () => {
    const merged = BossData.mergeEvents([event("b", 2)], [event("a", 1), event("b", 2)])
    expect(merged.map((e) => e.id)).toEqual(["a", "b"])
  })
})

describe("BossData.entitiesByState", () => {
  test("orders by charter state order and puts blocked last", () => {
    const r = run([
      { id: "e1", state: "reviewing" },
      { id: "e2", state: "blocked" },
      { id: "e3", state: "queued" },
    ])
    const groups = BossData.entitiesByState(r, ["queued", "reviewing", "done", "blocked"])
    const nonEmpty = groups.filter((g) => g.entities.length > 0).map((g) => g.state)
    expect(nonEmpty).toEqual(["queued", "reviewing", "blocked"])
  })
})

describe("BossData.eventTone", () => {
  test("flags failure events as errors", () => {
    expect(BossData.eventTone("guard_failed")).toBe("error")
    expect(BossData.eventTone("effect_failed")).toBe("error")
    expect(BossData.eventTone("entity_blocked")).toBe("error")
    expect(BossData.eventTone("budget_exhausted")).toBe("warn")
    expect(BossData.eventTone("entity_transitioned")).toBe("default")
  })
})
