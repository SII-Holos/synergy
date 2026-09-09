import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildTypeTestEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createTypeTestEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "type-test-engineer",
    description:
      "Tests static type contracts. Use for TypeScript generics, overloads, schemas, public types, Rust trait bounds, typestates, compile-fail behavior, or typed Python protocols and stubs. Provide the type surface and expected contract; the agent returns type tests, compile expectations, blockers, and reusable context. NOT for behavioral correctness tests (use test-strategist) or invariant testing (use property-test-engineer).",
    prompt: buildTypeTestEngineerPrompt(),
    model: "thinking",
    permission: "anchoredTestWrite",
  })
}
