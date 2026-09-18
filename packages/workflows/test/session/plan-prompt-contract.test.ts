import { describe, expect, test } from "bun:test"
import PLAN from "../../src/session/prompt/plan.txt"
import PLAN_SYNERGY from "../../src/session/prompt/plan-synergy.txt"
import PLAN_SYNERGY_MAX from "../../src/session/prompt/plan-synergy-max.txt"
import LATTICE_BASE from "@ericsanchezok/synergy-workflows/lattice/prompt/base.txt"
import LATTICE_AWAITING_EXECUTION from "@ericsanchezok/synergy-workflows/lattice/prompt/state-awaiting-execution.txt"
import LATTICE_CLARIFYING from "@ericsanchezok/synergy-workflows/lattice/prompt/state-clarifying.txt"
import LATTICE_AUTO from "@ericsanchezok/synergy-workflows/lattice/prompt/mode-auto.txt"
import LATTICE_BLUEPRINTING from "@ericsanchezok/synergy-workflows/lattice/prompt/state-blueprinting.txt"
import LATTICE_PLANNING from "@ericsanchezok/synergy-workflows/lattice/prompt/state-planning.txt"
import LATTICE_REVIEWING_BLUEPRINT from "@ericsanchezok/synergy-workflows/lattice/prompt/state-reviewing-blueprint.txt"
import LATTICE_REVIEWING_PATHWAY from "@ericsanchezok/synergy-workflows/lattice/prompt/state-reviewing-pathway.txt"

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

  test("keeps the Blueprint quality bar that makes a plan detailed and professional", () => {
    expect(PLAN).toContain("create or refine a high-quality Blueprint")
    expect(PLAN).toContain("A Blueprint is an executable delivery contract.")
    expect(PLAN).toContain("It must be decision-complete")
    expect(PLAN).toContain("a later execution session should not need to choose")
    expect(PLAN).toContain("A Blueprint is not a machine checklist.")
    expect(PLAN).toContain("Every Blueprint must contain these sections in this order.")
    expect(PLAN).toContain("cannot substitute a materially different route while claiming compliance")
    expect(PLAN).toContain("could two competent executors follow the Blueprint")
    expect(PLAN_SYNERGY).toContain("Producing a Blueprint that a downstream agent can follow autonomously")
    expect(PLAN_SYNERGY).toContain('explain what to do, why, what to avoid, and what "done" looks like')
    expect(PLAN_SYNERGY).toContain("Finalizing only decision-complete Blueprints with one material delivery route")
    expect(PLAN_SYNERGY_MAX).toContain("strong enough for autonomous implementation")
    expect(PLAN_SYNERGY_MAX).toContain("Explicitly reject plausible alternatives")
  })

  test("frames Plan as deliverable guidance rather than an enforced toolkit boundary", () => {
    expect(PLAN).toContain("Deliver a Blueprint, not the requested outcome.")
    expect(PLAN).toContain("This workflow does not gate your tools.")
    expect(PLAN).toContain("Investigation is unrestricted and expected")
    expect(PLAN).toContain("run commands, tests, and builds")
    expect(PLAN).toContain("The boundary is the deliverable, not the toolkit.")
    expect(PLAN).toContain("belong to the execution session")
    expect(PLAN).toContain("Do not launch execution agents that implement or modify the requested deliverable.")
    expect(PLAN).not.toContain("toolkit is restricted")
    expect(PLAN).not.toContain("You CANNOT modify project files")
    expect(PLAN).not.toContain("Plan restrictions")
    expect(PLAN).not.toContain("bypass Plan mode")
  })

  test("describes the permission boundary without restoring tool prohibitions", () => {
    expect(PLAN).not.toContain("You MUST NOT")
    expect(PLAN).not.toContain("Run shell commands that write files")
    expect(PLAN).not.toContain("Use read-only tools")
    expect(PLAN).not.toContain("Use bash for read-only repository inspection")
  })

  test("requires Lattice-authored Blueprints to use the same route contract", () => {
    expect(LATTICE_CLARIFYING).toContain("submit_requirements")
    expect(LATTICE_CLARIFYING).toContain("blocking question")
    expect(LATTICE_AUTO).toContain("clarifying")
    expect(LATTICE_REVIEWING_PATHWAY).toContain("adversarial self-review")
    expect(LATTICE_PLANNING).toContain("observable outcome")
    expect(LATTICE_PLANNING).toContain("representative end-to-end scenario")
    expect(LATTICE_BLUEPRINTING).toContain("same eight required sections")
    expect(LATTICE_BLUEPRINTING).toContain("one material implementation route")
    expect(LATTICE_BLUEPRINTING).toContain("evidence appropriate to the claim")
    expect(LATTICE_REVIEWING_BLUEPRINT).toContain("blocking verification need")
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
    expect(LATTICE_BASE).toContain("LATTICE_ACTION_QUEUED")
    expect(LATTICE_BASE).toContain("Do not call another tool, poll, resubmit")

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
