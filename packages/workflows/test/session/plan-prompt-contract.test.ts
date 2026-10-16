import { describe, expect, test } from "bun:test"
import LATTICE_BASE from "@ericsanchezok/synergy-lattice/lattice/prompt/base.txt"
import LATTICE_AWAITING_EXECUTION from "@ericsanchezok/synergy-lattice/lattice/prompt/state-awaiting-execution.txt"
import LATTICE_CLARIFYING from "@ericsanchezok/synergy-lattice/lattice/prompt/state-clarifying.txt"
import LATTICE_AUTO from "@ericsanchezok/synergy-lattice/lattice/prompt/mode-auto.txt"
import LATTICE_BLUEPRINTING from "@ericsanchezok/synergy-lattice/lattice/prompt/state-blueprinting.txt"
import LATTICE_PLANNING from "@ericsanchezok/synergy-lattice/lattice/prompt/state-planning.txt"
import LATTICE_REVIEWING_BLUEPRINT from "@ericsanchezok/synergy-lattice/lattice/prompt/state-reviewing-blueprint.txt"
import LATTICE_REVIEWING_PATHWAY from "@ericsanchezok/synergy-lattice/lattice/prompt/state-reviewing-pathway.txt"

describe("Lattice planning and execution boundaries", () => {
  test("requires Lattice-authored Blueprints to use the same route contract", () => {
    expect(LATTICE_CLARIFYING).toContain("submit_requirements")
    expect(LATTICE_CLARIFYING).toContain("blocking question")
    expect(LATTICE_AUTO).toContain("clarifying")
    expect(LATTICE_REVIEWING_PATHWAY).toContain("adversarial self-review")
    expect(LATTICE_PLANNING).toContain("observable outcome")
    expect(LATTICE_PLANNING).toContain("representative end-to-end scenario")
    expect(LATTICE_BLUEPRINTING).toContain("detail proportional to the Step")
    expect(LATTICE_BLUEPRINTING).toContain("evidence appropriate to the claim")
    expect(LATTICE_REVIEWING_BLUEPRINT).toContain("blocking verification need")
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
