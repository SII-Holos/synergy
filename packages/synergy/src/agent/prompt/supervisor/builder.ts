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
      "Internal BlueprintLoop audit agent. Verifies implementation completeness and either restarts the loop with concrete findings or marks it complete.",
    prompt: buildSupervisorPrompt(),
    model: "thinking",
    permission: "supervisor",
    visibleTo: [],
  })
}
