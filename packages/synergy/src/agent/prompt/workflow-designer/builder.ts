import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildWorkflowDesignerPrompt(): string {
  return PROMPT_BASE
}

export function createWorkflowDesignerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "workflow-designer",
    description:
      "Designs multi-agent DAGs for complex work. Use when a task has multiple phases, parallel branches, TDD gates, reviews, or user checkpoints. Produces nodes, dependencies, assigned agents, quality gates, expected outputs, and decision points.",
    prompt: buildWorkflowDesignerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
