import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildFixtureBuilderPrompt(): string {
  return PROMPT_BASE
}

export function createFixtureBuilderAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "fixture-builder",
    description:
      "Builds test fixtures, mocks, fakes, temporary scopes, sample config, and isolated harnesses. Use when tests require setup that should be deterministic, reusable, and isolated from real user state, network, credentials, or external systems.",
    prompt: buildFixtureBuilderPrompt(),
    model: "mid",
    permission: "implementation",
  })
}
