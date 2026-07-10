import { describe, expect, test } from "bun:test"
import { CharterValidate } from "../../src/workflow-run/charter-validate"
import { IssueToPrCharter } from "../../src/workflow-run/builtin/issue-to-pr"
import { WorkflowTypes } from "../../src/workflow-run/types"

function baseDraft(): CharterValidate.Draft {
  return {
    name: "T",
    entityType: "issue",
    entityInitialState: "queued",
    states: ["queued", "done", WorkflowTypes.BLOCKED_STATE],
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
        id: "go",
        from: "queued",
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

  test("a minimal well-formed draft is valid", () => {
    expect(CharterValidate.validate(baseDraft()).valid).toBe(true)
  })

  test("missing blocked state is a hard error", () => {
    const draft = baseDraft()
    draft.states = ["queued", "done"]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("blocked"))).toBe(true)
  })

  test("unknown predicate is a hard error", () => {
    const draft = baseDraft()
    draft.transitions[0].guards = [{ name: "no_such_predicate", args: {} }]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("no_such_predicate"))).toBe(true)
  })

  test("unknown effect is a hard error", () => {
    const draft = baseDraft()
    draft.transitions[0].effects = [{ name: "no_such_effect", args: {} }]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("no_such_effect"))).toBe(true)
  })

  test("intent allowing an unknown seat is a hard error", () => {
    const draft = baseDraft()
    draft.transitions[0].trigger = { kind: "intent", allowedSeats: ["ghost"] }
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("ghost"))).toBe(true)
  })

  test("transition to a nonexistent state is a hard error", () => {
    const draft = baseDraft()
    draft.transitions[0].to = "nowhere"
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("nowhere"))).toBe(true)
  })

  test("unreachable state produces a warning, not an error", () => {
    const draft = baseDraft()
    draft.states = ["queued", "done", "orphan", WorkflowTypes.BLOCKED_STATE]
    draft.terminalStates = ["done", "orphan"]
    const result = CharterValidate.validate(draft)
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.includes("orphan") && w.includes("unreachable"))).toBe(true)
  })
})
