import { describe, expect, test } from "bun:test"
import { CharterValidate } from "../../src/workflow-run/charter-validate"
import { IssueToPrCharter } from "../../src/workflow-run/builtin/issue-to-pr"
import { WorkflowGuards } from "../../src/workflow-run/guards"
import { WorkflowTypes } from "../../src/workflow-run/types"

/** A minimal charter that actually dispatches work (event → assign, intent → done). */
function baseDraft(): CharterValidate.Draft {
  return {
    name: "T",
    entityType: "issue",
    entityInitialState: "queued",
    states: ["queued", "working", "done", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done"],
    seats: [
      {
        name: "worker",
        agent: "synergy",
        charterPrompt: "do the thing",
        pool: 1,
        worktree: "none",
        interaction: "unattended",
      },
    ],
    transitions: [
      {
        id: "assign",
        from: "queued",
        to: "working",
        trigger: { kind: "event" },
        guards: [],
        effects: [{ name: "assign_entity", args: { seat: "worker" } }],
      },
      {
        id: "go",
        from: "working",
        to: "done",
        trigger: { kind: "intent", allowedSeats: ["worker"] },
        guards: [],
        effects: [],
      },
    ],
    gates: [],
    budget: { maxModelCalls: 10 },
  }
}

describe("CharterValidate", () => {
  test("the built-in Issue → PR → Test charter is valid", () => {
    const draft = IssueToPrCharter.draft()
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(draft.seats.map((seat) => [seat.name, seat.worktree])).toEqual([
      ["executor", "per_entity"],
      ["reviewer", "per_entity"],
      ["tester", "per_entity"],
    ])
  })

  test("a minimal auto-dispatching draft is valid", () => {
    expect(CharterValidate.validate(baseDraft()).valid).toBe(true)
  })

  test("a missing blocked state is auto-fixed, not an error", () => {
    const draft = baseDraft()
    draft.states = ["queued", "working", "done"]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(true)
    expect(result.fixes.some((f) => f.includes("blocked"))).toBe(true)
    expect(result.normalized.states).toContain(WorkflowTypes.BLOCKED_STATE)
  })

  test("an initial state with no event transition is a dead-machine error", () => {
    const draft = baseDraft()
    // Only an intent transition out of the initial state — nothing auto-dispatches.
    draft.transitions = [
      {
        id: "go",
        from: "queued",
        to: "done",
        trigger: { kind: "intent", allowedSeats: ["worker"] },
        guards: [],
        effects: [{ name: "assign_entity", args: { seat: "worker" } }],
      },
    ]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("no outgoing event transition"))).toBe(true)
  })

  test("a charter that never dispatches to a seat is an error", () => {
    const draft = baseDraft()
    draft.transitions = [
      { id: "assign", from: "queued", to: "working", trigger: { kind: "event" }, guards: [], effects: [] },
      {
        id: "go",
        from: "working",
        to: "done",
        trigger: { kind: "intent", allowedSeats: ["worker"] },
        guards: [],
        effects: [],
      },
    ]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("dispatches work to a seat"))).toBe(true)
  })

  test("unknown predicate error lists available predicates", () => {
    const draft = baseDraft()
    draft.transitions[1].guards = [{ name: "no_such_predicate", args: {} }]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    const err = result.errors.find((e) => e.includes("no_such_predicate"))
    expect(err).toBeDefined()
    expect(err).toContain("Available:")
    expect(err).toContain("budget_available")
  })

  test("unknown effect error lists available effects", () => {
    const draft = baseDraft()
    draft.transitions[1].effects = [{ name: "no_such_effect", args: {} }]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    const err = result.errors.find((e) => e.includes("no_such_effect"))
    expect(err).toContain("Available:")
    expect(err).toContain("send_handoff")
  })

  test("intent allowing an unknown seat is a hard error", () => {
    const draft = baseDraft()
    draft.transitions[1].trigger = { kind: "intent", allowedSeats: ["ghost"] }
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("ghost"))).toBe(true)
  })

  test("duplicate transition ids, seat names, and gate names are hard errors", () => {
    const draft = baseDraft()
    draft.transitions.push({ ...draft.transitions[1] })
    draft.seats.push({ ...draft.seats[0] })
    draft.gates = [
      { name: "approval", title: "Approval", resolutions: ["yes", "no"] },
      { name: "approval", title: "Another approval", resolutions: ["yes", "no"] },
    ]

    const result = CharterValidate.validate(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("duplicate transition id 'go'")
    expect(result.errors).toContain("duplicate seat name 'worker'")
    expect(result.errors).toContain("duplicate gate name 'approval'")
    expect(result.fixes.some((fix) => fix.includes("later definition wins"))).toBe(false)
  })

  test("transition to a nonexistent state is a hard error", () => {
    const draft = baseDraft()
    draft.transitions[1].to = "nowhere"
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("nowhere"))).toBe(true)
  })

  test("unreachable state produces a warning, not an error", () => {
    const draft = baseDraft()
    draft.states = ["queued", "working", "done", "orphan", WorkflowTypes.BLOCKED_STATE]
    draft.terminalStates = ["done", "orphan"]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.includes("orphan") && w.includes("unreachable"))).toBe(true)
  })

  test("exposes the available guard and effect catalogs", () => {
    expect(CharterValidate.availableGuards()).toContain("seat_available")
    expect(CharterValidate.availableEffects()).toContain("assign_entity")
  })

  test("the built-in executor cannot advance without a fresh deliverable", async () => {
    const transition = IssueToPrCharter.draft().transitions.find((item) => item.id === "executor_opens_pr")!
    const submissionGuard = transition.guards.find((guard) => guard.name === "submission_recorded")!
    const entity = guardEntity({
      state: "executing",
      stateEntered: 200,
      submissions: [submission({ kind: "deliverable", time: 199 })],
    })

    expect((await WorkflowGuards.evaluateAll(guardContext(entity), transition.guards)).ok).toBe(false)
    entity.submissions.push(submission({ kind: "deliverable", time: 201 }))
    expect((await WorkflowGuards.evaluateAll(guardContext(entity), [submissionGuard])).ok).toBe(true)
  })

  test("the built-in reviewer cannot request changes without a fresh changes-requested verdict", async () => {
    const transition = IssueToPrCharter.draft().transitions.find((item) => item.id === "review_request_changes")!
    const entity = guardEntity({
      state: "reviewing",
      stateEntered: 200,
      submissions: [
        submission({ kind: "review_verdict", verdict: "changes_requested", time: 199 }),
        submission({ kind: "review_verdict", verdict: "passed", time: 201 }),
      ],
    })

    expect((await WorkflowGuards.evaluateAll(guardContext(entity), transition.guards)).ok).toBe(false)
    entity.submissions.push(submission({ kind: "review_verdict", verdict: "changes_requested", time: 201 }))
    expect((await WorkflowGuards.evaluateAll(guardContext(entity), transition.guards)).ok).toBe(true)
  })
})

function submission(
  input: Pick<WorkflowTypes.Submission, "kind" | "time"> & Partial<WorkflowTypes.Submission>,
): WorkflowTypes.Submission {
  return {
    id: `sub_${input.time}`,
    seat: "worker",
    sessionID: "ses_worker",
    summary: "result",
    refs: [],
    ...input,
  }
}

function guardEntity(input: {
  state: string
  stateEntered: number
  submissions: WorkflowTypes.Submission[]
}): WorkflowTypes.Entity {
  return {
    id: "wfe_test",
    runID: "wfr_test",
    title: "Test entity",
    state: input.state,
    bindings: {},
    submissions: input.submissions,
    time: { created: 1, updated: 1, stateEntered: input.stateEntered },
  }
}

function guardContext(entity: WorkflowTypes.Entity): WorkflowGuards.Context {
  return {
    scopeID: "scope_test",
    entity,
    run: {
      id: "wfr_test",
      scopeID: "scope_test",
      charterRef: { id: "cht_test", version: 1 },
      title: "Test",
      status: "active",
      revision: 0,
      bossSessionID: "ses_boss",
      bossControlProfile: "guarded",
      seats: [],
      entities: [entity],
      gates: [],
      pendingEffects: [],
      budget: { maxModelCalls: 10, used: 0 },
      time: { created: 1, updated: 1 },
    },
  }
}
