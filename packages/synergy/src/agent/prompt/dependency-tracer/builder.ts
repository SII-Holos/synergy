import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildDependencyTracerPrompt(): string {
  return PROMPT_BASE
}

export function createDependencyTracerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "dependency-tracer",
    description:
      "Traces references and downstream impact for proposed changes. Use before renames, schema changes, API changes, tool changes, package boundary changes, or cross-module refactors. Reports direct references, indirect dependents, compatibility risk, and required follow-ups.",
    prompt: buildDependencyTracerPrompt(),
    model: "mid",
    permission: "analysis",
  })
}
