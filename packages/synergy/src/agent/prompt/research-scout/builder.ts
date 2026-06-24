import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildResearchScoutPrompt(): string {
  return PROMPT_BASE
}

export function createResearchScoutAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "research-scout",
    description:
      "Performs broad cross-source research across official sources, open-source examples, community practice, industry writing, product/design references, and academic leads. Use for ecosystem surveys, design/product/technical topic research, comparative practice analysis, and questions that need breadth before synthesis. Provide the research question, important dimensions, known constraints, and desired depth; the agent returns source coverage, findings, contradictions, synthesis, gaps, and reusable context. NOT for exact API/version verification (use docs-researcher), academic literature-only surveys (use literature-searcher), deep paper analysis (use literature-analyst), or experiment design (use research-methodologist).",
    prompt: buildResearchScoutPrompt(),
    model: "mid",
    permission: "externalResearch",
  })
}
