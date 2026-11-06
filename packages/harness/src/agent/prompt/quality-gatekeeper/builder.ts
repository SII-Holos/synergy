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
      "Runs toolchain-level quality checks (format, lint, typecheck, test) and reports pass or fail. Use after implementation, after refactor, and before delivery. For human-side concerns like naming, dead code, redundant logic, and clarity — use maintainability-reviewer. Provide changed paths, gate level, and known commands if available; the agent detects the toolchain, runs appropriate checks, separates environment failures from code failures, and returns blockers and reusable context.",
    prompt: buildQualityGatekeeperPrompt(),
    model: "mid",
    permission: "quality",
  })
}
