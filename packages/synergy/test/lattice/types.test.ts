import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { LatticeTypes } from "../../src/lattice/types"

function rawRun(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: Identifier.ascending("lattice_run"),
    scopeID: "scope_test",
    sessionID: Identifier.ascending("session"),
    mode: "auto",
    maxModelCalls: 0,
    modelCallCount: 0,
    status: "active",
    state: "clarifying",
    revision: 0,
    stateRevision: 0,
    pathwayRevision: 0,
    pathway: [],
    time: { created: 1, updated: 1 },
  }
}

describe("LatticeTypes v2", () => {
  test("accepts only strict schemaVersion 2 run records", () => {
    expect(LatticeTypes.Run.safeParse(rawRun()).success).toBe(true)
    expect(LatticeTypes.Run.safeParse({ ...rawRun(), schemaVersion: 1 }).success).toBe(false)
    expect(LatticeTypes.Run.safeParse({ ...rawRun(), phase: "initial_planning" }).success).toBe(false)
    expect(LatticeTypes.Run.safeParse({ ...rawRun(), unknown: true }).success).toBe(false)
  })

  test("projects a public view without controller bookkeeping or digests", () => {
    const now = 1_700_000_000_000
    const stepID = Identifier.ascending("lattice_step")
    const run = LatticeTypes.Run.parse({
      ...rawRun(),
      state: "executing",
      currentStepID: stepID,
      pendingAction: {
        id: Identifier.ascending("lattice_action"),
        source: "panel",
        kind: "approve_execution",
        reason: "approved",
        blueprintVersion: 2,
        contentDigest: "private-action-digest",
        expectedStateRevision: 4,
        expectedPathwayRevision: 1,
        time: { created: now },
      },
      effect: {
        id: Identifier.ascending("lattice_effect"),
        kind: "start_blueprint_loop",
        stepID,
        loopID: Identifier.ascending("blueprint_loop"),
        blueprintVersion: 2,
        sourceDigest: "private-effect-digest",
        time: { created: now },
      },
      pathway: [
        {
          id: stepID,
          title: "Implement",
          objective: "Ship",
          status: "current",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [],
          blueprint: {
            noteID: "note_blueprint",
            boundVersion: 2,
            contentDigest: "private-binding-digest",
            reviewedVersion: 2,
            reviewedContentDigest: "private-review-digest",
            time: { bound: now, reviewed: now },
          },
          time: { created: now, updated: now },
        },
      ],
    })
    const view = LatticeTypes.toRunView(run)
    expect(LatticeTypes.RunView.safeParse(view).success).toBe(true)
    expect("pendingAction" in view).toBe(false)
    expect("effect" in view).toBe(false)
    expect("contentDigest" in view.pathway[0].blueprint!).toBe(false)
    expect(JSON.stringify(view)).not.toContain("private-")
  })
})
