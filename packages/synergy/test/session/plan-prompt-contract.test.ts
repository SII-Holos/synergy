import { describe, expect, test } from "bun:test"
import PLAN from "../../src/session/prompt/plan.txt"
import PLAN_SYNERGY from "../../src/session/prompt/plan-synergy.txt"
import PLAN_SYNERGY_MAX from "../../src/session/prompt/plan-synergy-max.txt"
import LATTICE_BASE from "../../src/lattice/prompt/base.txt"
import LATTICE_AWAITING_EXECUTION from "../../src/lattice/prompt/state-awaiting-execution.txt"
import LATTICE_CLARIFYING from "../../src/lattice/prompt/state-clarifying.txt"
import LATTICE_AUTO from "../../src/lattice/prompt/mode-auto.txt"
import LATTICE_BLUEPRINTING from "../../src/lattice/prompt/state-blueprinting.txt"
import LATTICE_PLANNING from "../../src/lattice/prompt/state-planning.txt"
import LATTICE_REVIEWING_BLUEPRINT from "../../src/lattice/prompt/state-reviewing-blueprint.txt"
import LATTICE_REVIEWING_PATHWAY from "../../src/lattice/prompt/state-reviewing-pathway.txt"

const REQUIRED_BLUEPRINT_SECTIONS = [
  "## Goal and Requirements",
  "## Current State and Constraints",
  "## Chosen Implementation Route",
  "## Rejected Alternatives",
  "## Change Scope and Boundaries",
  "## Implementation Sequence",
  "## Risks and Edge Cases",
  "## Verification and Done Criteria",
]

describe("Plan Blueprint prompt contract", () => {
  test("converges material route forks before finalizing a Blueprint", () => {
    expect(PLAN).toContain("materially different implementation routes")
    expect(PLAN).toContain("single clarification checkpoint")
    expect(PLAN).toContain("one `question` call")
    expect(PLAN).toContain("Do not call `question` again for that Blueprint")
    expect(PLAN).toContain("two competent executors")
    expect(PLAN).toContain("not decision-complete")
  })

  test("does not encourage iterative clarification", () => {
    expect(PLAN_SYNERGY_MAX).not.toContain("continue, and ask again")
    expect(PLAN_SYNERGY).toContain("single clarification checkpoint")
    expect(PLAN_SYNERGY_MAX).toContain("single clarification checkpoint")
    expect(PLAN_SYNERGY_MAX).toContain("mutually exclusive")
  })

  test("requires the shared eight-section Blueprint structure", () => {
    for (const section of REQUIRED_BLUEPRINT_SECTIONS) {
      expect(PLAN).toContain(section)
    }
  })

  test("keeps synergy domain-general and synergy-max coding-specific", () => {
    expect(PLAN_SYNERGY).toContain("audience, structure, methodology")
    expect(PLAN_SYNERGY).toContain("routine production details")
    expect(PLAN_SYNERGY_MAX).toContain("existing owner or abstraction to extend")
    expect(PLAN_SYNERGY_MAX).toContain("parallel state or duplicate ownership")
  })

  test("requires Lattice-authored Blueprints to use the same route contract", () => {
    expect(LATTICE_CLARIFYING).toContain("submit_requirements")
    expect(LATTICE_CLARIFYING).toContain("blocking question")
    expect(LATTICE_AUTO).toContain("clarifying")
    expect(LATTICE_REVIEWING_PATHWAY).toContain("adversarial self-review")
    expect(LATTICE_BLUEPRINTING).toContain("same eight required sections")
    expect(LATTICE_BLUEPRINTING).toContain("one material implementation route")
    for (const section of REQUIRED_BLUEPRINT_SECTIONS) {
      expect(LATTICE_BLUEPRINTING).toContain(section)
    }
  })

  test("keeps Lattice replanning scoped to the editable future", () => {
    expect(LATTICE_BASE).toContain("pathway.editableFuture")
    expect(LATTICE_BASE).toContain("pathway_write.futureSteps")
    expect(LATTICE_REVIEWING_PATHWAY).toContain("Never copy pathway.history or pathway.current")
    expect(LATTICE_PLANNING).toContain("pathway_write.futureSteps")
  })

  test("ends the turn after a successful Lattice state submission", () => {
    expect(LATTICE_BASE).toContain("final tool call")
    expect(LATTICE_BASE).toContain("still report the current state")
    expect(LATTICE_BASE).toContain("Do not poll, resubmit, or begin the next state")

    for (const statePrompt of [
      LATTICE_AWAITING_EXECUTION,
      LATTICE_CLARIFYING,
      LATTICE_PLANNING,
      LATTICE_REVIEWING_PATHWAY,
      LATTICE_BLUEPRINTING,
      LATTICE_REVIEWING_BLUEPRINT,
    ]) {
      expect(statePrompt).toContain("final tool call")
      expect(statePrompt).toContain("end the turn")
    }
  })
})
