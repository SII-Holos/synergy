import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildIntegrationEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createIntegrationEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "integration-engineer",
    description:
      "Integrates outputs from multiple agents into a coherent change set. Use after parallel implementation, tests, docs, or review fixes. Resolves interface mismatches, naming drift, import conflicts, and inconsistent assumptions.",
    prompt: buildIntegrationEngineerPrompt(),
    model: "thinking",
    permission: "implementation",
  })
}
