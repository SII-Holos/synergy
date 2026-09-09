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
      "Designs public contracts before implementation. Use for tools, route schemas, SDK types, config fields, CLI options, plugin APIs, agent definitions, and prompt-visible descriptions. Provide the goal and known constraints; the agent returns schema shape, field semantics, error model, wiring obligations, blockers, and reusable context. NOT for implementing contracts (use implementation-engineer), reviewing existing contracts (use api-compatibility-reviewer), or planning migrations (use migration-architect).",
    prompt: buildApiContractDesignerPrompt(),
    model: "thinking",
    permission: "readOnly",
  })
}
