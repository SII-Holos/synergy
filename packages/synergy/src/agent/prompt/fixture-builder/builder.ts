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
      "Builds test fixtures, mocks, fakes, temporary scopes, sample config, and isolated harnesses. Use when tests need deterministic setup or isolation from real state, network, credentials, or external systems. Provide the test goal and existing patterns; the agent returns fixtures, isolation guarantees, example usage, blockers, and reusable context. NOT for writing behavioral tests (use test-strategist), reproducing bugs (use regression-reproducer), or verifying invariants (use property-test-engineer).",
    prompt: buildFixtureBuilderPrompt(),
    model: "mid",
    permission: "anchoredTestWrite",
  })
}
