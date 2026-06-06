import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildPerformanceReviewerPrompt(): string {
  return PROMPT_BASE
}

export function createPerformanceReviewerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "performance-reviewer",
    description:
      "Reviews performance and resource risk. Use for hot paths, prompt assembly, file scanning, tool output, server routes, UI rendering, concurrency, caching, streaming, and large repository workflows. Provide changed scope and expected workload if available; the agent returns risks, benchmark needs, blockers, and reusable context.",
    prompt: buildPerformanceReviewerPrompt(),
    model: "thinking",
    permission: "review",
  })
}
