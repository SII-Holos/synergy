import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildResearchMethodologistPrompt(): string {
  return PROMPT_BASE
}

export function createResearchMethodologistAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "research-methodologist",
    description:
      "Designs research-grade methods, experiments, baselines, metrics, and evidence plans. Use when coding work involves ML, benchmarks, algorithms, empirical claims, evaluation protocols, or paper-quality evidence. Provide the research goal and constraints; the agent returns method design, validity risks, required experiments, blockers, and reusable context. NOT for literature survey (use literature-searcher), implementation (use implementation-engineer), or code-level review (use appropriate reviewer agent).",
    prompt: buildResearchMethodologistPrompt(),
    model: "thinking",
    permission: "research",
  })
}
