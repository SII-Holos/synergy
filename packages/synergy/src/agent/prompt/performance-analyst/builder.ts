import { PermissionNext } from "@/permission/next"
import type { Agent } from "../../agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildPerformanceAnalystPrompt(): string {
  return PROMPT_BASE
}

export function createPerformanceAnalystAgent(ctx: BuiltinAgentContext): Agent.Info {
  return {
    name: "performance-analyst",
    description: "Analyzes bounded redacted runtime telemetry from the Performance panel.",
    prompt: buildPerformanceAnalystPrompt(),
    mode: "subagent",
    native: true,
    hidden: true,
    permission: PermissionNext.fromConfig({ "*": "deny" }),
    options: {},
    temperature: 0.2,
    steps: 4,
    ...resolveAgentModelRole(ctx, "thinking"),
  }
}
