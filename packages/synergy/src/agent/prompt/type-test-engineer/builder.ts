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
      "Tests static type contracts for TypeScript, Rust, and typed Python APIs. Use when generics, overloads, trait bounds, typestates, protocols, schemas, or public type surfaces are part of correctness.",
    prompt: buildTypeTestEngineerPrompt(),
    model: "thinking",
    permission: "implementation",
  })
}
