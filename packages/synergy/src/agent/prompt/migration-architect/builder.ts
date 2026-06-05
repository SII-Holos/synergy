import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildMigrationArchitectPrompt(): string {
  return PROMPT_BASE
}

export function createMigrationArchitectAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "migration-architect",
    description:
      "Plans migrations for data, configuration, persisted state, agent names, tool schemas, and public contracts. Use when a change affects existing users or stored objects. Produces migration need, affected data, upgrade path, fallback behavior, and tests.",
    prompt: buildMigrationArchitectPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
