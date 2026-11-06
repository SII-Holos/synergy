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
      "Runs and interprets Rust quality tooling. Use for Rust crates or workspaces. Provide changed paths, workspace context, and feature constraints if available; the agent handles cargo fmt, clippy, check, test, nextest, doc, deny, audit, llvm-cov, Miri, semver-checks, udeps, and fuzzing blockers.",
    prompt: buildRustQualityEngineerPrompt(),
    model: "mid",
    permission: "quality",
  })
}
