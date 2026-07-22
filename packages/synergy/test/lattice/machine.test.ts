import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { LatticeError } from "../../src/lattice/error"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeTypes } from "../../src/lattice/types"

function run(overrides: Partial<LatticeTypes.Run> = {}): LatticeTypes.Run {
  const now = 1_700_000_000_000
  return LatticeTypes.Run.parse({
    schemaVersion: 2,
    id: Identifier.ascending("lattice_run"),
    scopeID: "scope_test",
    sessionID: Identifier.ascending("session"),
    mode: "auto",
    maxModelCalls: 0,
    modelCallCount: 0,
    status: "active",
    state: "clarifying",
    goalSeed: "Ship it",
    revision: 0,
    stateRevision: 0,
    pathwayRevision: 0,
    pathway: [],
    time: { created: now, updated: now },
    ...overrides,
  })
}

function action<T extends LatticeTypes.PendingAction>(value: Omit<T, "id" | "source" | "time">): T {
  return LatticeTypes.PendingAction.parse({
    ...value,
    source: "agent",
    id: Identifier.ascending("lattice_action"),
    time: { created: 1_700_000_000_001 },
  }) as T
}

describe("LatticeMachine", () => {
  test("drives requirements and Pathway review without coupling artifact writes to state changes", () => {
    const requirementsAction = action<LatticeTypes.SubmitRequirementsAction>({
      kind: "submit_requirements",
      expectedStateRevision: 0,
      expectedPathwayRevision: 0,
      requirements: {
        goal: "Release safely",
        successCriteria: ["all checks pass"],
        constraints: ["do not edit session core"],
        nonGoals: [],
        assumptions: [],
      },
    })
    const planning = LatticeMachine.consumePendingAction(
      { ...run(), pendingAction: requirementsAction },
      1_700_000_000_002,
    )
    expect(planning.state).toBe("planning")
    expect(planning.stateRevision).toBe(1)
    expect(planning.requirements?.goal).toBe("Release safely")
    expect(planning.pendingAction).toBeUndefined()

    const planned = LatticeMachine.writePathway(
      planning,
      [
        { title: "Inventory", objective: "Map the change" },
        { title: "Implement", objective: "Land the change", acceptanceCriteria: ["tests pass"] },
      ],
      1_700_000_000_003,
    )
    expect(planned.state).toBe("planning")
    expect(planned.pathwayRevision).toBe(1)
    expect(planned.pathway.map((step) => step.status)).toEqual(["pending", "pending"])

    const review = LatticeMachine.consumePendingAction(
      {
        ...planned,
        pendingAction: action<LatticeTypes.SubmitPathwayAction>({
          kind: "submit_pathway",
          reason: "The decomposition is executable",
          expectedStateRevision: 1,
          expectedPathwayRevision: 1,
        }),
      },
      1_700_000_000_004,
    )
    expect(review.state).toBe("reviewing_pathway")
    expect(review.currentStepID).toBeUndefined()

    const blueprinting = LatticeMachine.consumePendingAction(
      {
        ...review,
        pendingAction: action<LatticeTypes.SubmitPathwayReviewAction>({
          kind: "submit_pathway_review",
          reason: "Proceed with the first step",
          expectedStateRevision: 2,
          expectedPathwayRevision: 1,
        }),
      },
      1_700_000_000_005,
    )
    expect(blueprinting.state).toBe("blueprinting")
    expect(LatticeMachine.currentStep(blueprinting)?.status).toBe("current")
  })

  test("binds and reviews a Blueprint before execution", () => {
    const initial = LatticeMachine.writePathway(
      run({
        state: "planning",
        stateRevision: 1,
        requirements: {
          goal: "Build",
          successCriteria: ["done"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
        },
      }),
      [{ title: "Build", objective: "Implement" }],
    )
    const reviewing = LatticeMachine.consumePendingAction({
      ...initial,
      pendingAction: action<LatticeTypes.SubmitPathwayAction>({
        kind: "submit_pathway",
        reason: "ready",
        expectedStateRevision: 1,
        expectedPathwayRevision: 1,
      }),
    })
    const blueprinting = LatticeMachine.consumePendingAction({
      ...reviewing,
      pendingAction: action<LatticeTypes.SubmitPathwayReviewAction>({
        kind: "submit_pathway_review",
        reason: "ready",
        expectedStateRevision: 2,
        expectedPathwayRevision: 1,
      }),
    })
    const selfReview = LatticeMachine.consumePendingAction({
      ...blueprinting,
      pendingAction: action<LatticeTypes.SubmitBlueprintAction>({
        kind: "submit_blueprint",
        blueprintID: "note_blueprint",
        blueprintVersion: 3,
        contentDigest: "sha256:bound",
        expectedStateRevision: 3,
        expectedPathwayRevision: 1,
      }),
    })
    expect(selfReview.state).toBe("reviewing_blueprint")
    expect(LatticeMachine.currentStep(selfReview)?.blueprint).toMatchObject({
      noteID: "note_blueprint",
      boundVersion: 3,
    })

    const executing = LatticeMachine.consumePendingAction({
      ...selfReview,
      pendingAction: action<LatticeTypes.SubmitBlueprintReviewAction>({
        kind: "submit_blueprint_review",
        reason: "safe to run",
        blueprintVersion: 3,
        contentDigest: "sha256:bound",
        expectedStateRevision: 4,
        expectedPathwayRevision: 1,
      }),
    })
    expect(executing.state).toBe("executing")
    expect(executing.effect?.kind).toBe("create_blueprint_loop")
    expect(LatticeMachine.currentStep(executing)?.blueprint?.reviewedVersion).toBe(3)
  })

  test("collaborative mode waits for explicit approval and rejects a changed Blueprint", () => {
    const now = 1_700_000_000_000
    const stepID = Identifier.ascending("lattice_step")
    const awaiting = run({
      mode: "collaborative",
      state: "awaiting_execution",
      stateRevision: 5,
      pathwayRevision: 1,
      currentStepID: stepID,
      pathway: [
        {
          id: stepID,
          title: "Build",
          objective: "Implement",
          status: "current",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [],
          blueprint: {
            noteID: "note_blueprint",
            boundVersion: 3,
            contentDigest: "sha256:bound",
            reviewedVersion: 3,
            reviewedContentDigest: "sha256:bound",
            time: { bound: now, reviewed: now },
          },
          time: { created: now, updated: now },
        },
      ],
    })

    expect(() =>
      LatticeMachine.consumePendingAction({
        ...awaiting,
        pendingAction: action<LatticeTypes.ApproveExecutionAction>({
          kind: "approve_execution",
          reason: "approved",
          blueprintVersion: 4,
          contentDigest: "sha256:changed",
          expectedStateRevision: 5,
          expectedPathwayRevision: 1,
        }),
      }),
    ).toThrow(LatticeError.StateConflict)

    const invalidated = LatticeMachine.invalidateBlueprintReview(awaiting, {
      version: 4,
      contentDigest: "sha256:changed",
    })
    expect(invalidated.state).toBe("reviewing_blueprint")
    expect(invalidated.effect).toBeUndefined()
  })

  test("returns to Pathway review after a successful loop and completes only after the last step", () => {
    const now = 1_700_000_000_000
    const firstID = Identifier.ascending("lattice_step")
    const secondID = Identifier.ascending("lattice_step")
    const loopID = Identifier.ascending("blueprint_loop")
    const executing = run({
      state: "executing",
      stateRevision: 5,
      pathwayRevision: 1,
      currentStepID: firstID,
      pathway: [
        {
          id: firstID,
          title: "A",
          objective: "a",
          status: "current",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [
            {
              loopID,
              status: "running",
              sourceDigest: "sha256:a",
              time: { created: now, started: now },
            },
          ],
          blueprint: {
            noteID: "note_a",
            boundVersion: 1,
            contentDigest: "sha256:a",
            reviewedVersion: 1,
            reviewedContentDigest: "sha256:a",
            time: { bound: now, reviewed: now },
          },
          time: { created: now, updated: now, started: now },
        },
        {
          id: secondID,
          title: "B",
          objective: "b",
          status: "pending",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [],
          time: { created: now, updated: now },
        },
      ],
    })
    const reviewing = LatticeMachine.onLoopTerminal(executing, {
      loopID,
      status: "completed",
      summary: "A done",
    })
    expect(reviewing.state).toBe("reviewing_pathway")
    expect(reviewing.status).toBe("active")
    expect(reviewing.currentStepID).toBeUndefined()
    expect(reviewing.pathway[0].status).toBe("completed")

    const onlyID = Identifier.ascending("lattice_step")
    const onlyLoopID = Identifier.ascending("blueprint_loop")
    const final = LatticeMachine.onLoopTerminal(
      run({
        state: "executing",
        stateRevision: 4,
        currentStepID: onlyID,
        pathway: [
          {
            id: onlyID,
            title: "Only",
            objective: "finish",
            status: "current",
            acceptanceCriteria: [],
            assumptions: [],
            blueprintHistory: [],
            loopHistory: [
              {
                loopID: onlyLoopID,
                status: "running",
                sourceDigest: "sha256:only",
                time: { created: now, started: now },
              },
            ],
            time: { created: now, updated: now, started: now },
          },
        ],
      }),
      { loopID: onlyLoopID, status: "completed" },
    )
    expect(final.status).toBe("completed")
    expect(final.currentStepID).toBeUndefined()
  })

  test("pauses on loop failure and only resume reopens the same step", () => {
    const now = 1_700_000_000_000
    const stepID = Identifier.ascending("lattice_step")
    const loopID = Identifier.ascending("blueprint_loop")
    const executing = run({
      state: "executing",
      stateRevision: 4,
      currentStepID: stepID,
      pathway: [
        {
          id: stepID,
          title: "A",
          objective: "a",
          status: "current",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [
            {
              loopID,
              status: "running",
              sourceDigest: "sha256:a",
              time: { created: now, started: now },
            },
          ],
          time: { created: now, updated: now, started: now },
        },
      ],
    })
    const paused = LatticeMachine.onLoopTerminal(executing, {
      loopID,
      status: "failed",
      error: "boom",
    })
    expect(paused.status).toBe("paused")
    expect(paused.pathway[0].status).toBe("failed")
    expect(paused.pathway[0].loopHistory[0].error).toBe("boom")

    const resumed = LatticeMachine.resume(paused)
    expect(resumed.status).toBe("active")
    expect(resumed.state).toBe("blueprinting")
    expect(resumed.currentStepID).toBe(stepID)
    expect(resumed.pathway[0].status).toBe("current")
    expect(resumed.pathway[0].loopHistory[0].status).toBe("failed")
  })

  test("explicit resume reopens an executing Step after a missing Loop ownership conflict", () => {
    const now = 1_700_000_000_000
    const stepID = Identifier.ascending("lattice_step")
    const loopID = Identifier.ascending("blueprint_loop")
    const paused = run({
      status: "paused",
      statusReason: "blueprint_loop_ownership_conflict",
      state: "executing",
      stateRevision: 5,
      currentStepID: stepID,
      pathway: [
        {
          id: stepID,
          title: "Recover",
          objective: "Recover a missing Loop",
          status: "executing",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [
            { loopID, status: "running", sourceDigest: "sha256:missing", time: { created: now, started: now } },
          ],
          time: { created: now, updated: now, started: now },
        },
      ],
      time: { created: now, updated: now, paused: now },
    })

    const resumed = LatticeMachine.resume(paused, {}, now + 1)
    expect(resumed.status).toBe("active")
    expect(resumed.state).toBe("blueprinting")
    expect(resumed.pathway[0].status).toBe("current")
    expect(resumed.pathway[0].loopHistory[0]).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("ownership_conflict"),
    })
  })

  test("explicit resume reopens an executing Step after duplicate Run quarantine cleared its handoff", () => {
    const now = 1_700_000_000_000
    const stepID = Identifier.ascending("lattice_step")
    const paused = run({
      status: "paused",
      statusReason: "duplicate_active_run",
      state: "executing",
      stateRevision: 5,
      currentStepID: stepID,
      pathway: [
        {
          id: stepID,
          title: "Recover",
          objective: "Recreate the interrupted handoff",
          status: "current",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [],
          time: { created: now, updated: now, started: now },
        },
      ],
      time: { created: now, updated: now, paused: now },
    })

    const resumed = LatticeMachine.resume(paused, {}, now + 1)

    expect(resumed.status).toBe("active")
    expect(resumed.state).toBe("blueprinting")
    expect(resumed.pathway[0].status).toBe("current")
    expect(resumed.effect).toBeUndefined()
  })

  test("keeps a user-paused Run paused when a late successful loop leaves more work", () => {
    const now = 1_700_000_000_000
    const stepID = Identifier.ascending("lattice_step")
    const nextID = Identifier.ascending("lattice_step")
    const loopID = Identifier.ascending("blueprint_loop")
    const paused = run({
      status: "paused",
      statusReason: "user_paused",
      state: "executing",
      stateRevision: 5,
      currentStepID: stepID,
      pathway: [
        {
          id: stepID,
          title: "A",
          objective: "a",
          status: "executing",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [{ loopID, status: "running", sourceDigest: "sha256:a", time: { created: now, started: now } }],
          time: { created: now, updated: now, started: now },
        },
        {
          id: nextID,
          title: "B",
          objective: "b",
          status: "pending",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [],
          time: { created: now, updated: now },
        },
      ],
      time: { created: now, updated: now, paused: now },
    })

    const completed = LatticeMachine.onLoopTerminal(paused, { loopID, status: "completed" }, now + 1)
    expect(completed.state).toBe("reviewing_pathway")
    expect(completed.status).toBe("paused")
    expect(completed.statusReason).toBe("user_paused")
  })

  test("rejects stale semantic actions", () => {
    expect(() =>
      LatticeMachine.consumePendingAction({
        ...run({ stateRevision: 2 }),
        pendingAction: action<LatticeTypes.SubmitRequirementsAction>({
          kind: "submit_requirements",
          expectedStateRevision: 1,
          expectedPathwayRevision: 0,
          requirements: {
            goal: "x",
            successCriteria: ["y"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
          },
        }),
      }),
    ).toThrow(LatticeError.StateConflict)
  })

  test("resume clears stale effects and either rebases or drops a pending action", () => {
    const pending = action<LatticeTypes.SubmitRequirementsAction>({
      kind: "submit_requirements",
      expectedStateRevision: 0,
      expectedPathwayRevision: 0,
      requirements: {
        goal: "Recover",
        successCriteria: ["continued"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
      },
    })
    const withEffect = LatticeMachine.setPromptEffect({ ...run(), pendingAction: pending }, { promptType: "resume" })
    const paused = LatticeMachine.pause(withEffect, "error")

    const preserved = LatticeMachine.resume(paused, { preservePendingAction: true })
    expect(preserved.effect).toBeUndefined()
    expect(preserved.pendingAction?.expectedStateRevision).toBe(preserved.stateRevision)
    expect(preserved.pendingAction?.expectedPathwayRevision).toBe(preserved.pathwayRevision)

    const dropped = LatticeMachine.resume(paused)
    expect(dropped.effect).toBeUndefined()
    expect(dropped.pendingAction).toBeUndefined()
  })

  test("resume reopens an execution handoff interrupted before its effect ran", () => {
    const stepID = Identifier.ascending("lattice_step")
    const interrupted = run({
      status: "paused",
      statusReason: "parent_turn_interrupted",
      state: "executing",
      currentStepID: stepID,
      pathwayRevision: 1,
      pathway: [
        {
          id: stepID,
          title: "Execute",
          objective: "Create loop",
          status: "current",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintHistory: [],
          loopHistory: [],
          time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        },
      ],
      effect: {
        id: Identifier.ascending("lattice_effect"),
        kind: "create_blueprint_loop",
        stepID,
        blueprintNoteID: "note_interrupted",
        blueprintVersion: 1,
        sourceDigest: "digest-interrupted",
        time: { created: 1_700_000_000_000 },
      },
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000, paused: 1_700_000_000_000 },
    })

    const resumed = LatticeMachine.resume(interrupted)

    expect(resumed.state).toBe("blueprinting")
    expect(LatticeMachine.currentStep(resumed)?.status).toBe("current")
    expect(resumed.effect).toBeUndefined()
  })
})
