import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import type { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import PROMPT_GITHUB_CHANNEL_AGENT from "./channel/prompts/github-channel-agent.txt"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"

export function createDomainAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  return {
    "github-channel-agent": {
      name: "github-channel-agent",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      temperature: 0,
      permission: PermissionNext.fromConfig({
        "*": "deny",
        read: "allow",
        grep: "allow",
        glob: "allow",
        edit: "allow",
        write: "allow",
        todoread: "allow",
        todowrite: "allow",
        // The fix-delivery tool must be callable from the whitelist.
        github_deliver_fix: "allow",
        bash: {
          "*": "allow",
          "gh*": "deny",
          "git push*": "deny",
          "git remote*": "deny",
        },
      }),
      prompt: PROMPT_GITHUB_CHANNEL_AGENT,
      ...resolveAgentModelRole(ctx, "mid"),
    },
  }
}

export function registerConnectionsAgents() {
  AgentBuiltins.register("connections", createDomainAgents)
}
