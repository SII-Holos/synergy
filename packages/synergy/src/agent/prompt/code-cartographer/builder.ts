import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildCodeCartographerPrompt(): string {
  return PROMPT_BASE
}

export function createCodeCartographerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "code-cartographer",
    description:
      "Maps the relevant code before changes. Use when the task touches unfamiliar code, spans modules, or needs root-cause location. Finds entry points, call flow, data flow, existing abstractions, likely change points, and risk areas with file citations.",
    prompt: buildCodeCartographerPrompt(),
    model: "mid",
    permission: "analysis",
  })
}
