import type { Info as SessionInfo } from "../session/types"
import BASE from "./prompt/base.txt"
import CONTINUE_BLUEPRINTING from "./prompt/continue-blueprinting.txt"
import CONTINUE_CLARIFYING from "./prompt/continue-clarifying.txt"
import CONTINUE_PLANNING from "./prompt/continue-planning.txt"
import CONTINUE_REVIEWING_BLUEPRINT from "./prompt/continue-reviewing-blueprint.txt"
import CONTINUE_REVIEWING_PATHWAY from "./prompt/continue-reviewing-pathway.txt"
import ENTRY_BLUEPRINTING from "./prompt/entry-blueprinting.txt"
import ENTRY_CLARIFYING from "./prompt/entry-clarifying.txt"
import ENTRY_PLANNING from "./prompt/entry-planning.txt"
import ENTRY_REVIEWING_BLUEPRINT from "./prompt/entry-reviewing-blueprint.txt"
import ENTRY_REVIEWING_PATHWAY from "./prompt/entry-reviewing-pathway.txt"
import MODE_AUTO from "./prompt/mode-auto.txt"
import MODE_COLLABORATIVE from "./prompt/mode-collaborative.txt"
import STATE_AWAITING_EXECUTION from "./prompt/state-awaiting-execution.txt"
import STATE_BLUEPRINTING from "./prompt/state-blueprinting.txt"
import STATE_CLARIFYING from "./prompt/state-clarifying.txt"
import STATE_PLANNING from "./prompt/state-planning.txt"
import STATE_REVIEWING_BLUEPRINT from "./prompt/state-reviewing-blueprint.txt"
import STATE_REVIEWING_PATHWAY from "./prompt/state-reviewing-pathway.txt"
import VALIDATION_REPAIR from "./prompt/validation-repair.txt"
import { LatticeMachine } from "./machine"
import { LatticeTypes } from "./types"

export namespace LatticePrompt {
  type ParentState = Exclude<LatticeTypes.State, "awaiting_execution" | "executing">

  const STATE_PROMPTS: Record<Exclude<LatticeTypes.State, "executing">, string> = {
    clarifying: STATE_CLARIFYING,
    planning: STATE_PLANNING,
    reviewing_pathway: STATE_REVIEWING_PATHWAY,
    blueprinting: STATE_BLUEPRINTING,
    reviewing_blueprint: STATE_REVIEWING_BLUEPRINT,
    awaiting_execution: STATE_AWAITING_EXECUTION,
  }

  const ENTRY_PROMPTS: Record<ParentState, string> = {
    clarifying: ENTRY_CLARIFYING,
    planning: ENTRY_PLANNING,
    reviewing_pathway: ENTRY_REVIEWING_PATHWAY,
    blueprinting: ENTRY_BLUEPRINTING,
    reviewing_blueprint: ENTRY_REVIEWING_BLUEPRINT,
  }

  const CONTINUATION_PROMPTS: Record<ParentState, string> = {
    clarifying: CONTINUE_CLARIFYING,
    planning: CONTINUE_PLANNING,
    reviewing_pathway: CONTINUE_REVIEWING_PATHWAY,
    blueprinting: CONTINUE_BLUEPRINTING,
    reviewing_blueprint: CONTINUE_REVIEWING_BLUEPRINT,
  }

  /** System-prompt block for a parent Lattice turn. Execution is owned by BlueprintLoop. */
  export function build(_session: Pick<SessionInfo, "workflow">, run: LatticeTypes.Run): string {
    if (run.state === "executing") return ""
    const mode = run.mode === "auto" ? MODE_AUTO : MODE_COLLABORATIVE
    return [BASE, mode, STATE_PROMPTS[run.state], context(run)]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n")
  }

  /** Durable state-entry, resume, or validation-repair body. */
  export function entry(
    run: LatticeTypes.Run,
    input: { promptType: LatticeTypes.PromptEffect["promptType"]; failures?: string[] },
  ): string {
    if (run.state === "executing" || run.state === "awaiting_execution") return ""
    const instruction =
      input.promptType === "repair"
        ? [VALIDATION_REPAIR.trim(), ...(input.failures ?? []).map((failure) => `- ${failure}`)].join("\n")
        : ENTRY_PROMPTS[run.state].trim()
    return [instruction, context(run)].filter(Boolean).join("\n\n")
  }

  /** Successful-turn continuation. Awaiting approval and execution never inject parent work. */
  export function continuation(run: LatticeTypes.Run): string {
    if (run.state === "executing" || run.state === "awaiting_execution") return ""
    return [CONTINUATION_PROMPTS[run.state].trim(), context(run)].join("\n\n")
  }

  function context(run: LatticeTypes.Run): string {
    const goal = run.requirements?.goal ?? run.goalSeed ?? "derive from the user's request"
    const budget =
      run.maxModelCalls > 0 ? `${run.modelCallCount}/${run.maxModelCalls}` : `${run.modelCallCount}/unlimited`
    return [
      "<lattice-context>",
      `State: ${run.state}`,
      `Mode: ${run.mode}`,
      `Canonical goal: ${goal}`,
      `Model calls: ${budget}`,
      currentStep(run),
      pathway(run),
      "</lattice-context>",
    ].join("\n")
  }

  function currentStep(run: LatticeTypes.Run): string {
    const step = LatticeMachine.currentStep(run)
    if (!step) return "Current Step: none selected."
    const lines = [
      "Current Step:",
      `- title: ${step.title}`,
      `- status: ${step.status}`,
      `- objective: ${step.objective}`,
    ]
    if (step.acceptanceCriteria.length) lines.push(`- acceptance criteria: ${step.acceptanceCriteria.join("; ")}`)
    if (step.failureReason) lines.push(`- prior failure: ${step.failureReason}`)
    if (step.blueprint) lines.push(`- blueprintID: ${step.blueprint.noteID}`)
    return lines.join("\n")
  }

  function pathway(run: LatticeTypes.Run): string {
    if (run.pathway.length === 0) return "Pathway: empty."
    return ["Pathway:", ...run.pathway.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`)].join("\n")
  }
}
