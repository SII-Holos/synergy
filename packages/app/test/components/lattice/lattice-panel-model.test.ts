import { describe, expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import {
  controlsForRun,
  currentStepForRun,
  latticeEventDescriptor,
  isCurrentLatticeActionTarget,
  isLatticeConflict,
  pathwayProgress,
  selectFresherRun,
  toggleExpandedPathwayStep,
  workStateDescriptor,
  type LatticeRunView,
} from "../../../src/components/lattice/lattice-panel-model"

function run(input: Partial<LatticeRunView> = {}): LatticeRunView {
  return {
    schemaVersion: 2,
    id: "run-1",
    scopeID: "home",
    sessionID: "session-1",
    mode: "collaborative",
    revision: 1,
    stateRevision: 0,
    pathwayRevision: 0,
    maxModelCalls: 20,
    modelCallCount: 3,
    pathway: [],
    status: "active",
    state: "clarifying",
    time: { created: 10, updated: 10 },
    ...input,
  } as LatticeRunView
}

function responseFetch(factory: () => Response): typeof fetch {
  return Object.assign(async () => factory(), { preconnect() {} })
}

describe("Lattice panel model", () => {
  test("maps every product work state to stable user-facing copy", () => {
    expect(
      [
        "clarifying",
        "planning",
        "reviewing_pathway",
        "blueprinting",
        "reviewing_blueprint",
        "awaiting_execution",
        "executing",
      ].map((state) => workStateDescriptor(state as never).message),
    ).toEqual([
      "Understanding",
      "Planning",
      "Reviewing Pathway",
      "Designing Blueprint",
      "Reviewing Blueprint",
      "Waiting for You",
      "Executing",
    ])
  })

  test("does not let a stale initial fetch overwrite a newer event", () => {
    const eventRun = run({ revision: 4, time: { created: 10, updated: 40 } })
    const fetchedRun = run({ revision: 2, time: { created: 10, updated: 20 } })

    expect(selectFresherRun(eventRun, fetchedRun)).toBe(eventRun)
    expect(selectFresherRun(eventRun, null)).toBe(eventRun)
  })

  test("accepts a newer replacement run but rejects late events from the old run", () => {
    const oldRun = run({ id: "run-old", revision: 12, time: { created: 10, updated: 80 } })
    const newRun = run({ id: "run-new", revision: 1, time: { created: 100, updated: 100 } })

    expect(selectFresherRun(oldRun, newRun)).toBe(newRun)
    expect(selectFresherRun(newRun, oldRun)).toBe(newRun)
  })

  test("uses ascending Run identity when replacement Runs share a creation timestamp", () => {
    const oldRun = run({ id: "ltr_0001", revision: 20, time: { created: 100, updated: 300 } })
    const newRun = run({ id: "ltr_0002", revision: 1, time: { created: 100, updated: 100 } })

    expect(selectFresherRun(oldRun, newRun)).toBe(newRun)
    expect(selectFresherRun(newRun, oldRun)).toBe(newRun)
  })

  test("ignores a deferred action completion after the panel switches Session or Run", async () => {
    const deferred = Promise.withResolvers<void>()
    const target = { generation: 1, sessionID: "session-1", runID: "run-1" }
    let current = { ...target }
    const applied: string[] = []
    const completion = deferred.promise.then(() => {
      if (isCurrentLatticeActionTarget(target, current)) applied.push("approval queued")
    })

    current = { generation: 2, sessionID: "session-2", runID: "run-2" }
    deferred.resolve()
    await completion

    expect(applied).toEqual([])
    expect(isCurrentLatticeActionTarget(target, { ...target, runID: "run-2" })).toBe(false)
    expect(isCurrentLatticeActionTarget(target, target)).toBe(true)
  })

  test("offers lifecycle controls without allowing terminal runs to mutate", () => {
    expect(controlsForRun(run())).toEqual({ pause: true, resume: true, cancel: true, approve: false })
    expect(
      controlsForRun(
        run({
          state: "awaiting_execution",
        }),
      ),
    ).toEqual({ pause: true, resume: false, cancel: true, approve: true })
    expect(controlsForRun(run({ status: "paused", statusReason: "user_paused", state: "blueprinting" }))).toEqual({
      pause: false,
      resume: true,
      cancel: true,
      approve: false,
    })
    expect(controlsForRun(run({ status: "completed" }))).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      approve: false,
    })
  })

  test("derives the focused step and compact progress from the durable Pathway", () => {
    const current = run({
      currentStepID: "step-2",
      pathway: [
        { id: "step-1", status: "completed", title: "Foundation" },
        { id: "step-2", status: "executing", title: "World generation" },
        { id: "step-3", status: "pending", title: "Interaction" },
        { id: "step-4", status: "failed", title: "Audio" },
      ] as LatticeRunView["pathway"],
    })

    expect(currentStepForRun(current)?.id).toBe("step-2")
    expect(pathwayProgress(current)).toEqual({
      completed: 1,
      failed: 1,
      pending: 1,
      total: 4,
    })
  })

  test("keeps at most one Pathway audit summary expanded", () => {
    expect(toggleExpandedPathwayStep(undefined, "step-1")).toBe("step-1")
    expect(toggleExpandedPathwayStep("step-1", "step-2")).toBe("step-2")
    expect(toggleExpandedPathwayStep("step-2", "step-2")).toBeUndefined()
  })

  test("presents audit event kinds as product language instead of persisted identifiers", () => {
    expect(latticeEventDescriptor("step_blueprint_bound").message).toBe("Blueprint prepared")
    expect(latticeEventDescriptor("budget_exhausted").message).toBe("Model-call budget reached")
    expect(latticeEventDescriptor("recovery_reconciled").message).toBe("Recovery step reconciled")
  })

  test("recognizes generated-client 409 conflicts so the panel can refresh reviewed state", async () => {
    const client = createSynergyClient({
      baseUrl: "http://lattice.test",
      throwOnError: true,
      fetch: responseFetch(
        () =>
          new Response(
            JSON.stringify({
              message: "Lattice state conflict",
              data: { state: "awaiting_execution", reason: "The reviewed Blueprint changed." },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
      ),
    })
    let thrown: unknown
    try {
      await client.lattice.run.approve({ id: "ltr_conflict" })
    } catch (error) {
      thrown = error
    }

    expect(thrown).not.toBeInstanceOf(Error)
    expect(isLatticeConflict(thrown)).toBe(true)

    const conflict = Object.assign(new Error("conflict"), {
      name: "APIError",
      data: { statusCode: 409, responseBody: JSON.stringify({ name: "LatticeStateConflictError" }) },
    })
    expect(isLatticeConflict(conflict)).toBe(true)
    expect(isLatticeConflict(new Error("network"))).toBe(false)
  })

  test("does not misclassify a generated-client 500 response as a Lattice conflict", async () => {
    const client = createSynergyClient({
      baseUrl: "http://lattice.test",
      throwOnError: true,
      fetch: responseFetch(
        () =>
          new Response(JSON.stringify({ message: "Internal server error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    })
    let thrown: unknown
    try {
      await client.lattice.run.approve({ id: "ltr_failure" })
    } catch (error) {
      thrown = error
    }

    expect(isLatticeConflict(thrown)).toBe(false)
    expect(isLatticeConflict({ message: "validation failed", data: { reason: "missing state" } })).toBe(false)
  })
})
