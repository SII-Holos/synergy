import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import type { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import PROMPT_MULTIMODAL_LOOKER from "./prompts/multimodal-looker.txt"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"

export function createDomainAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  return {
    "multimodal-looker": {
      name: "multimodal-looker",
      prompt: PROMPT_MULTIMODAL_LOOKER,
      options: {},
      permission: PermissionNext.merge(
        ctx.defaults,
        PermissionNext.fromConfig({
          skill: { "*": "deny" },
          external_directory: { "*": "allow" },
        }),
        ctx.user,
      ),
      mode: "primary",
      native: true,
      hidden: true,
      ...resolveAgentModelRole(ctx, "vision"),
    },
  }
}

export function registerMediaAgents() {
  AgentBuiltins.register("media", createDomainAgents)
}
