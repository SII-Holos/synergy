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
      "Builds lightweight test setup, fakes, temporary scopes, sample config, and isolated harnesses only when direct setup is not enough. Use when tests need deterministic isolation from real state, network, credentials, or external systems. Provide the test goal and existing patterns; the agent returns minimal fixtures, isolation guarantees, blockers, and reusable context. NOT for writing behavioral tests (use test-strategist) or verifying invariants (use property-test-engineer).",
    prompt: buildFixtureBuilderPrompt(),
    model: "mid",
    permission: "anchoredTestWrite",
  })
}
