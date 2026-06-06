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
      "Designs multi-agent DAGs for complex work. Use when work has phases, dependencies, parallel branches, TDD gates, reviews, or user checkpoints. Provide the task goal and known constraints; the agent returns DAG nodes, dependencies, assigned subagents, quality gates, blockers, and reusable context.",
    prompt: buildWorkflowDesignerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
