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
      "Plans migrations for persisted state, configuration, schemas, names, and public contracts. Use when existing users or stored objects may be affected. Provide the planned change and known storage/config context; the agent returns migration need, affected state, upgrade path, tests, blockers, and reusable context.",
    prompt: buildMigrationArchitectPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
