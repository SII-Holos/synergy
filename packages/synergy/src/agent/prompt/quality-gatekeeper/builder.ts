import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildQualityGatekeeperPrompt(): string {
  return PROMPT_BASE
}

export function createQualityGatekeeperAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "quality-gatekeeper",
    description:
      "Runs project quality gates and reports structured pass or fail. Use after tests are written, after implementation, after refactor, and before final delivery. Detects toolchain, runs format, lint, typecheck, tests, coverage, security, or language-specific gates.",
    prompt: buildQualityGatekeeperPrompt(),
    model: "mid",
    permission: "quality",
  })
}
