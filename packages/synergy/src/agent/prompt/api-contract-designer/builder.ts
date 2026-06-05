import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildApiContractDesignerPrompt(): string {
  return PROMPT_BASE
}

export function createApiContractDesignerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "api-contract-designer",
    description:
      "Designs public contracts for tools, routes, SDK types, config fields, CLI options, plugins, and agent definitions. Use before implementation when field names, schemas, return metadata, error shape, or compatibility behavior must be stable.",
    prompt: buildApiContractDesignerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
