import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildSupervisorPrompt(): string {
  return PROMPT_BASE
}

export function createSupervisorAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "supervisor",
    description:
      "Audits whether a Blueprint has been fully and correctly implemented. Use after an implementation loop completes. Provide the Blueprint noteID and implementation evidence; the agent reads the Blueprint, examines session trajectory, git diff, and test results, dispatches audit subagents, and returns a completion assessment with restart or finish recommendation.",
    prompt: buildSupervisorPrompt(),
    model: "thinking",
    permission: "supervisor",
    visibleTo: ["synergy-max"],
  })
}
