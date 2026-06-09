import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildLiteratureSearcherPrompt(): string {
  return PROMPT_BASE
}

export function createLiteratureSearcherAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "literature-searcher",
    description:
      "Discovers and triages academic literature via arXiv and web search. Use for finding recent papers, surveying a research field, or identifying relevant work before deep analysis. Provide the research question and known constraints; the agent searches multi-pass with recency bias, returns a curated paper list with relevance scores, summaries, and reusable context for downstream analysis.",
    prompt: buildLiteratureSearcherPrompt(),
    model: "mid",
    permission: "research",
  })
}
