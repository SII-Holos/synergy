import { describe, expect, test } from "bun:test"
import PLAN from "../../src/session/prompt/plan.txt"
import PLAN_SYNERGY from "../../src/session/prompt/plan-synergy.txt"
import PLAN_SYNERGY_MAX from "../../src/session/prompt/plan-synergy-max.txt"
import LATTICE_STEP_BLUEPRINTING from "../../src/lattice/prompt/phase-step-blueprinting.txt"

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
    expect(PLAN).toContain("Ask the user only when")
    expect(PLAN).toContain("two competent executors")
    expect(PLAN).toContain("not decision-complete")
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
    expect(LATTICE_STEP_BLUEPRINTING).toContain("same eight required sections")
    expect(LATTICE_STEP_BLUEPRINTING).toContain("one material implementation route")
    for (const section of REQUIRED_BLUEPRINT_SECTIONS) {
      expect(LATTICE_STEP_BLUEPRINTING).toContain(section)
    }
  })
})
