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
      "Traces references and downstream impact for proposed changes. Use before renames, schema edits, API changes, tool changes, config changes, package boundary changes, or refactors. Provide the target symbol or planned change; the agent inspects references and returns impact, risk, follow-ups, blockers, and reusable context.",
    prompt: buildDependencyTracerPrompt(),
    model: "mid",
    permission: "analysis",
  })
}
