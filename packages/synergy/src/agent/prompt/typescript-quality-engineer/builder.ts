import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildTypescriptQualityEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createTypescriptQualityEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "typescript-quality-engineer",
    description:
      "Runs and interprets TypeScript and JavaScript quality tooling. Use for TS/JS projects. Handles Prettier, Biome, ESLint, Oxlint, tsc, Vitest, Jest, Bun test, Playwright, Knip, type-coverage, package audit, and bundle checks.",
    prompt: buildTypescriptQualityEngineerPrompt(),
    model: "mid",
    permission: "quality",
  })
}
