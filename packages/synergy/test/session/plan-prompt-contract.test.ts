import { describe, expect, test } from "bun:test"
import PLAN from "../../src/session/prompt/plan.txt"
import PLAN_SYNERGY from "../../src/session/prompt/plan-synergy.txt"
import PLAN_SYNERGY_MAX from "../../src/session/prompt/plan-synergy-max.txt"
import LATTICE_CLARIFYING from "../../src/lattice/prompt/state-clarifying.txt"
import LATTICE_AUTO from "../../src/lattice/prompt/mode-auto.txt"
import LATTICE_BLUEPRINTING from "../../src/lattice/prompt/state-blueprinting.txt"
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
})
