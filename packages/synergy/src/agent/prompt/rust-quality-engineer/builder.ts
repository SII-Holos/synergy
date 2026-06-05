import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildRustQualityEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createRustQualityEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "rust-quality-engineer",
    description:
      "Runs and interprets Rust quality tooling. Use for Rust crates and workspaces. Handles cargo fmt, clippy, check, test, nextest, doc, deny, audit, llvm-cov, Miri, semver-checks, udeps, and fuzzing when appropriate.",
    prompt: buildRustQualityEngineerPrompt(),
    model: "mid",
    permission: "quality",
  })
}
