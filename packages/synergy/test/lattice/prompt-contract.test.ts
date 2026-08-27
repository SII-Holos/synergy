import { describe, expect, test } from "bun:test"
import type { Info as SessionInfo } from "../../src/session/types"
import { LatticePrompt } from "../../src/lattice/prompt"
import type { LatticeTypes } from "../../src/lattice/types"
import BASE from "../../src/lattice/prompt/base.txt"
import MODE_AUTO from "../../src/lattice/prompt/mode-auto.txt"
import MODE_COLLABORATIVE from "../../src/lattice/prompt/mode-collaborative.txt"
import STATE_PLANNING from "../../src/lattice/prompt/state-planning.txt"
import STATE_CLARIFYING from "../../src/lattice/prompt/state-clarifying.txt"
import { WorkflowUserWrapper } from "../../src/session/workflow-user-wrapper"

/**
 * Lattice prompt contract (S5a golden). Locks the byte-level shape of the
 * parent Lattice system block (assembly order, separators, <lattice-context>
 * projection) and the lattice user-message wrappers before the S5b vertical
 * slice moves the wrapper bytes into the lattice domain and routes the
 * invoke.ts call sites through the workflow prompt registry. Any diff here
 * must be an explicit product decision, never a refactor side effect.
 */

function step(input: {
  id: string
  title: string
  status: LatticeTypes.StepStatus
  objective: string
  acceptanceCriteria?: string[]
  failureReason?: string
  blueprint?: { noteID: string }
}): LatticeTypes.Step {
  return {
    id: input.id,
    title: input.title,
    objective: input.objective,
    status: input.status,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    assumptions: [],
    blueprintHistory: [],
    loopHistory: [],
    ...(input.blueprint ? { blueprint: input.blueprint } : {}),
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    time: { created: 1, updated: 2 },
  } as unknown as LatticeTypes.Step
}

function runFixture(over: Record<string, unknown> = {}): LatticeTypes.Run {
  return {
    schemaVersion: 2,
    id: "ltr_alpha",
    scopeID: "scope_test",
    sessionID: "ses_parent",
    mode: "auto",
    maxModelCalls: 10,
    modelCallCount: 3,
    status: "active",
    state: "planning",
    requirements: { goal: "Ship the importer" },
    currentStepID: "lst_transform",
    revision: 4,
    stateRevision: 2,
    pathwayRevision: 3,
    pathway: [
      step({ id: "lst_extract", title: "Extract records", status: "completed", objective: "Extract legacy records" }),
      step({
        id: "lst_transform",
        title: "Transform records",
        status: "current",
        objective: "Transform records into the new schema",
        acceptanceCriteria: ["Transformed rows pass validation"],
        failureReason: "prior run lost the column mapping",
        blueprint: { noteID: "nte_transform" },
      }),
      step({ id: "lst_verify", title: "Verify counts", status: "pending", objective: "Verify record counts" }),
    ],
    time: { created: 1, updated: 2 },
    ...over,
  } as unknown as LatticeTypes.Run
}

const session = { workflow: { kind: "lattice", runID: "ltr_alpha", mode: "auto" } } as unknown as SessionInfo

const PLANNING_CONTEXT = [
  "<lattice-context>",
  "State: planning",
  "Mode: auto",
  "Canonical goal: Ship the importer",
  "Model calls: 3/10",
  "Current Step:",
  "- title: Transform records",
  "- status: current",
  "- objective: Transform records into the new schema",
  "- acceptance criteria: Transformed rows pass validation",
  "- prior failure: prior run lost the column mapping",
  "- blueprintID: nte_transform",
  "Pathway:",
  "1. [completed] Extract records",
  "2. [current] Transform records",
  "3. [pending] Verify counts",
  "</lattice-context>",
].join("\n")

describe("lattice system prompt golden", () => {
  test("planning/auto composition is byte-exact (base + mode + state + context, blank-line joined)", () => {
    expect(LatticePrompt.build(session, runFixture())).toBe(
      [BASE.trim(), MODE_AUTO.trim(), STATE_PLANNING.trim(), PLANNING_CONTEXT].join("\n\n"),
    )
  })

  test("collaborative mode swaps the mode block; goal falls back to the sentinel without requirements", () => {
    const block = LatticePrompt.build(
      { workflow: { kind: "lattice", runID: "ltr_alpha", mode: "collaborative" } } as unknown as SessionInfo,
      runFixture({
        mode: "collaborative",
        state: "clarifying",
        requirements: undefined,
        currentStepID: undefined,
        pathway: [],
      }),
    )
    expect(block).toBe(
      [
        BASE.trim(),
        MODE_COLLABORATIVE.trim(),
        STATE_CLARIFYING.trim(),
        [
          "<lattice-context>",
          "State: clarifying",
          "Mode: collaborative",
          "Canonical goal: derive from the user's request",
          "Model calls: 3/10",
          "Current Step: none selected.",
          "Pathway: empty.",
          "</lattice-context>",
        ].join("\n"),
      ].join("\n\n"),
    )
  })

  test("unlimited budget renders the unlimited sentinel", () => {
    const block = LatticePrompt.build(session, runFixture({ maxModelCalls: 0, modelCallCount: 7 }))
    expect(block).toContain("Model calls: 7/unlimited")
  })

  test("executing state produces no parent system block", () => {
    expect(LatticePrompt.build(session, runFixture({ state: "executing" }))).toBe("")
  })

  test("goalSeed is used when requirements are absent", () => {
    const block = LatticePrompt.build(session, runFixture({ requirements: undefined, goalSeed: "Seed goal text" }))
    expect(block).toContain("Canonical goal: Seed goal text")
  })
})

describe("lattice user-message wrapper golden", () => {
  test("generic agent wrapper is byte-exact", () => {
    expect(WorkflowUserWrapper.build("some-agent", "lattice", "decompose the migration")).toBe(
      [
        "<lattice-user-request>",
        "You are in the Lattice workflow.",
        "Treat this message as evidence for the current Lattice responsibility; follow the current Lattice system state instead of restarting the workflow.",
        "While clarifying, investigate and align requirements before proposing a Pathway or Blueprint.",
        "",
        "User request:",
        "decompose the migration",
        "</lattice-user-request>",
      ].join("\n"),
    )
  })

  test("synergy wrapper is byte-exact", () => {
    expect(WorkflowUserWrapper.build("synergy", "lattice", "decompose the migration")).toBe(
      [
        "<lattice-user-request>",
        "You are synergy in the Lattice workflow.",
        "Treat this message as evidence for the current Lattice responsibility; follow the current Lattice system state instead of restarting the workflow.",
        "While clarifying, investigate and align requirements before proposing a Pathway or Blueprint.",
        "",
        "User request:",
        "decompose the migration",
        "</lattice-user-request>",
      ].join("\n"),
    )
  })

  test("synergy-max wrapper is byte-exact", () => {
    expect(WorkflowUserWrapper.build("synergy-max", "lattice", "decompose the migration")).toBe(
      [
        "<lattice-user-request>",
        "You are synergy-max in the Lattice workflow.",
        "Treat this message as evidence for the current Lattice responsibility; follow the current Lattice system state instead of restarting the workflow.",
        "While clarifying, investigate and align requirements before proposing a Pathway or Blueprint.",
        "",
        "User request:",
        "decompose the migration",
        "</lattice-user-request>",
      ].join("\n"),
    )
  })

  test("empty request normalizes to the sentinel", () => {
    expect(WorkflowUserWrapper.build("synergy", "lattice", "   ")).toContain("(empty request)")
  })
})

describe("lattice control-source suppression golden", () => {
  const latticeSession = { workflow: { kind: "lattice", runID: "r1", mode: "auto" } } as never

  test("lattice_continuation suppresses workflow stamping", () => {
    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: latticeSession,
        metadata: { source: "lattice_continuation" },
        agentName: "synergy",
      }),
    ).toEqual({})
  })

  test("unstamped user requests still get workflow metadata", () => {
    expect(WorkflowUserWrapper.metadataForUserMessage({ session: latticeSession, agentName: "synergy" })).toEqual({
      workflow: "lattice",
      workflowAgent: "synergy",
      workflowVersion: 1,
    })
  })
})
