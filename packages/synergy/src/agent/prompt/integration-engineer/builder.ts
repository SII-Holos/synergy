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
      "Integrates outputs from multiple agents into one coherent change set. Use after parallel implementation, test, docs, or review work. Provide prior findings and current scope; the agent resolves interface mismatches, naming drift, import conflicts, and inconsistent assumptions, then returns verification needs and reusable context.",
    prompt: buildIntegrationEngineerPrompt(),
    model: "thinking",
    permission: "codeWrite",
  })
}
