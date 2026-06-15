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
      "Maps repository context before changes. Use for unfamiliar code, root-cause location, cross-module work, or when the primary agent needs entry points, call flow, existing abstractions, likely change points, and risk areas. Provide the goal and any known symbols/files; the agent inspects missing context and returns cited code evidence. NOT for tracing dependency impact (use dependency-tracer), writing code (use implementation-engineer), editing files, or researching external documentation (use docs-researcher).",
    prompt: buildCodeCartographerPrompt(),
    model: "mid",
    permission: "readOnly",
  })
}
