import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import type { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import PROMPT_ANIMA from "./prompts/anima.txt"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"

export function createDomainAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  return {
    anima: {
      name: "anima",
      description:
        "Autonomous inner self that runs periodic routines — reflects on recent activity, organizes knowledge, plans agenda tasks, engages with the community, and explores the web to learn. Not a user-facing agent; runs as a background daily routine.",
      prompt: PROMPT_ANIMA,
      mode: "primary",
      native: true,
      hidden: true,
      permission: PermissionNext.merge(
        ctx.defaults,
        PermissionNext.fromConfig({
          // Override defaults that are "ask" → "allow" (anima runs unattended)
          edit: "allow",
          write: "allow",
          external_directory: { "*": "allow" },
          // Safety gates
          question: "deny",
          todowrite: "deny",
          todoread: "deny",
        }),
        ctx.user,
      ),
      options: {},
      controlProfile: "autonomous",
      ...resolveAgentModelRole(ctx, "mid"),
    },
  }
}

export function registerWorkflowsAgents() {
  AgentBuiltins.register("workflows", createDomainAgents)
}
