import { describe, expect, test } from "bun:test"
import { WorkflowGuards } from "../../src/workflow-run/guards"
import { WorkflowTypes } from "../../src/workflow-run/types"

function makeEntity(overrides: Partial<WorkflowTypes.Entity> = {}): WorkflowTypes.Entity {
  const now = Date.now()
  return {
    id: "wfe_test",
    runID: "wfr_test",
    title: "E",
    state: "reviewing",
    bindings: {},
    submissions: [],
    time: { created: now, updated: now, stateEntered: now },
    ...overrides,
  }
}

function makeRun(entity: WorkflowTypes.Entity, overrides: Partial<WorkflowTypes.Run> = {}): WorkflowTypes.Run {
  const now = Date.now()
  return {
    id: "wfr_test",
    scopeID: "scope",
    charterRef: { id: "cht_test", version: 1 },
    title: "R",
    status: "active",
    revision: 0,
    bossSessionID: "ses_boss",
    seats: [],
    entities: [entity],
    gates: [],
    pendingEffects: [],
    budget: { maxModelCalls: 0, used: 0 },
    time: { created: now, updated: now },
    ...overrides,
  }
}

describe("WorkflowGuards.resolveArg", () => {
  test("resolves entity binding, entity field, run field, and literal", () => {
    const entity = makeEntity({ bindings: { loopID: "bll_1" }, state: "reviewing" })
    const run = makeRun(entity, { title: "Release" })
    const ctx = { scopeID: "scope", run, entity }
    expect(WorkflowGuards.resolveArg("$entity.bindings.loopID", ctx)).toBe("bll_1")
    expect(WorkflowGuards.resolveArg("$entity.state", ctx)).toBe("reviewing")
    expect(WorkflowGuards.resolveArg("$run.title", ctx)).toBe("Release")
    expect(WorkflowGuards.resolveArg("plain", ctx)).toBe("plain")
    expect(WorkflowGuards.resolveArg("$entity.bindings.missing", ctx)).toBeUndefined()
  })
})

describe("submission_recorded predicate", () => {
  test("passes when a matching submission exists", async () => {
    const entity = makeEntity({
      submissions: [
        {
          id: "s1",
          kind: "review_verdict",
          seat: "reviewer",
          sessionID: "ses_r",
          verdict: "passed",
          summary: "ok",
          refs: [],
          time: Date.now(),
        },
      ],
    })
    const ctx = { scopeID: "scope", run: makeRun(entity), entity }
    const result = await WorkflowGuards.evaluate("submission_recorded", ctx, {
      kind: "review_verdict",
      verdict: "passed",
    })
    expect(result.ok).toBe(true)
  })

  test("fresh=true rejects a submission recorded before the current state was entered", async () => {
    const stateEntered = Date.now()
    const entity = makeEntity({
      time: { created: stateEntered, updated: stateEntered, stateEntered },
      submissions: [
        {
          id: "old",
          kind: "review_verdict",
          seat: "reviewer",
          sessionID: "ses_r",
          verdict: "passed",
          summary: "stale",
          refs: [],
          time: stateEntered - 1000, // recorded before entering this state
        },
      ],
    })
    const ctx = { scopeID: "scope", run: makeRun(entity), entity }
    const stale = await WorkflowGuards.evaluate("submission_recorded", ctx, {
      kind: "review_verdict",
      verdict: "passed",
      fresh: "true",
    })
    expect(stale.ok).toBe(false)

    // Without fresh, the stale submission still matches.
    const lenient = await WorkflowGuards.evaluate("submission_recorded", ctx, {
      kind: "review_verdict",
      verdict: "passed",
    })
    expect(lenient.ok).toBe(true)
  })
})

describe("budget_available predicate", () => {
  test("unlimited budget always passes", async () => {
    const entity = makeEntity()
    const ctx = { scopeID: "scope", run: makeRun(entity, { budget: { maxModelCalls: 0, used: 999 } }), entity }
    expect((await WorkflowGuards.evaluate("budget_available", ctx, {})).ok).toBe(true)
  })

  test("exhausted budget fails", async () => {
    const entity = makeEntity()
    const ctx = { scopeID: "scope", run: makeRun(entity, { budget: { maxModelCalls: 5, used: 5 } }), entity }
    expect((await WorkflowGuards.evaluate("budget_available", ctx, {})).ok).toBe(false)
  })
})

describe("gate_resolved predicate", () => {
  test("matches a resolved gate with an accepted resolution", async () => {
    const entity = makeEntity({ id: "wfe_1", state: "awaiting_merge" })
    const run = makeRun(entity, {
      gates: [
        {
          id: "wfg_1",
          gate: "final_merge",
          entityID: "wfe_1",
          transitionID: "merge",
          status: "resolved",
          resolution: "merge",
          time: { created: Date.now(), resolved: Date.now() },
        },
      ],
    })
    const ctx = { scopeID: "scope", run, entity }
    expect((await WorkflowGuards.evaluate("gate_resolved", ctx, { gate: "final_merge", accept: "merge" })).ok).toBe(
      true,
    )
    expect((await WorkflowGuards.evaluate("gate_resolved", ctx, { gate: "final_merge", accept: "rework" })).ok).toBe(
      false,
    )
  })
})

describe("unknown predicate", () => {
  test("fails closed", async () => {
    const entity = makeEntity()
    const result = await WorkflowGuards.evaluate("does_not_exist", { scopeID: "s", run: makeRun(entity), entity }, {})
    expect(result.ok).toBe(false)
  })
})
