import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildPythonQualityEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createPythonQualityEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "python-quality-engineer",
    description:
      "Runs and interprets Python quality tooling. Use for Python files or projects. Provide changed paths and known project commands if available; the agent handles Ruff, Mypy, Pyright, Pytest, Coverage, Bandit, Semgrep, Vulture, Pydoclint, Interrogate, Pip-audit, and related blockers.",
    prompt: buildPythonQualityEngineerPrompt(),
    model: "mid",
    permission: "quality",
  })
}
