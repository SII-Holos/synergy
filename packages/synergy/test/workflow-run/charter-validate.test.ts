import { describe, expect, test } from "bun:test"
import { CharterValidate } from "../../src/workflow-run/charter-validate"
import { IssueToPrCharter } from "../../src/workflow-run/builtin/issue-to-pr"
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
        controlProfile: "autonomous",
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
    const result = CharterValidate.validate(IssueToPrCharter.draft())
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
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
})
