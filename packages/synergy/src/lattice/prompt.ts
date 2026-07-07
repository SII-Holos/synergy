import type { Info as SessionInfo } from "../session/types"
import BASE from "./prompt/base.txt"
import MODE_AUTO from "./prompt/mode-auto.txt"
import MODE_COLLABORATIVE from "./prompt/mode-collaborative.txt"
import PHASE_INITIAL_PLANNING from "./prompt/phase-initial-planning.txt"
import PHASE_STEP_BLUEPRINTING from "./prompt/phase-step-blueprinting.txt"
import PHASE_BLUEPRINT_REVIEW from "./prompt/phase-blueprint-review.txt"
import PHASE_BLUEPRINT_EXECUTION from "./prompt/phase-blueprint-execution.txt"
import PHASE_RESULT_ANALYSIS from "./prompt/phase-result-analysis.txt"
import CONTINUATION from "./prompt/continuation.txt"
import { LatticeMachine } from "./machine"
import { LatticeTypes } from "./types"

export namespace LatticePrompt {
  const PHASE_PROMPTS: Record<LatticeTypes.Phase, string> = {
    initial_planning: PHASE_INITIAL_PLANNING,
    step_blueprinting: PHASE_STEP_BLUEPRINTING,
    blueprint_review: PHASE_BLUEPRINT_REVIEW,
    blueprint_execution: PHASE_BLUEPRINT_EXECUTION,
    result_analysis: PHASE_RESULT_ANALYSIS,
  }

  const NEXT_TRANSITION: Record<LatticeTypes.Phase, string> = {
    initial_planning: "Writing a selectable step moves you to step_blueprinting.",
    step_blueprinting:
      "Binding a Blueprint moves you to blueprint_execution (auto) or blueprint_review (collaborative).",
    blueprint_review: "The user's Continue action moves you to blueprint_execution.",
    blueprint_execution: "The BlueprintLoop finishing moves you to result_analysis.",
    result_analysis: "Updating the Pathway selects the next step (step_blueprinting) or completes the run.",
  }

  /** Full Lattice system-prompt block for an active run. */
  export function build(_session: Pick<SessionInfo, "lattice">, run: LatticeTypes.Run): string {
    const modePrompt = run.mode === "auto" ? MODE_AUTO : MODE_COLLABORATIVE
    return [BASE.trim(), modePrompt.trim(), PHASE_PROMPTS[run.phase].trim(), dynamicContext(run)].join("\n\n")
  }

  /** Synthetic continuation message body used to wake an idle run. */
  export function continuation(run: LatticeTypes.Run): string {
    return [CONTINUATION.trim(), "", dynamicContext(run)].join("\n")
  }

  function dynamicContext(run: LatticeTypes.Run): string {
    const budget = run.maxModelCalls > 0 ? `${run.modelCallCount}/${run.maxModelCalls}` : `${run.modelCallCount}/unlimited`
    const lines = [
      "<lattice-context>",
      `Run: ${run.id}`,
      `Mode: ${run.mode}`,
      `Phase: ${run.phase}`,
      `Status: ${run.status}`,
      `Model calls: ${budget}`,
      goalLine(run),
      "",
      currentStepBlock(run),
      "",
      pathwaySummary(run),
      "",
      `Next automatic transition: ${NEXT_TRANSITION[run.phase]}`,
      "</lattice-context>",
    ]
    return lines.filter((line) => line !== undefined).join("\n")
  }

  function goalLine(run: LatticeTypes.Run): string {
    return run.goal ? `Goal: ${run.goal}` : "Goal: (derive from the user's request)"
  }

  function currentStepBlock(run: LatticeTypes.Run): string {
    const step = LatticeMachine.currentStep(run)
    if (!step) return "Current step: none selected yet."
    const lines = [
      "Current step:",
      `- id: ${step.id}`,
      `- title: ${step.title}`,
      `- status: ${step.status}`,
      `- objective: ${step.objective}`,
    ]
    if (step.acceptanceCriteria.length) {
      lines.push(`- acceptance criteria: ${step.acceptanceCriteria.map((c) => `(${c})`).join(" ")}`)
    }
    if (step.blueprintNoteID) lines.push(`- blueprint note: ${step.blueprintNoteID}`)
    if (step.blueprintLoopID) lines.push(`- blueprint loop: ${step.blueprintLoopID}`)
    if (step.failureReason) lines.push(`- failure: ${step.failureReason}`)
    return lines.join("\n")
  }

  function pathwaySummary(run: LatticeTypes.Run): string {
    if (run.pathway.length === 0) return "Pathway: empty."
    const rows = run.pathway.map((step, index) => {
      const marker = step.id === run.currentStepID ? "→" : " "
      return `${marker} ${index + 1}. [${step.status}] ${step.title}`
    })
    return ["Pathway (execution order):", ...rows].join("\n")
  }
}
