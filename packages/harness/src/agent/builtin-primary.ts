import { PrimaryAgentIdentity } from "./primary-identity"

import { PermissionNext } from "../permission/next"
import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"

function primaryPermission(ctx: BuiltinAgentContext): PermissionNext.Ruleset {
  return PermissionNext.merge(
    ctx.defaults,
    PermissionNext.fromConfig({
      question: "allow",
      runtime_reload: "allow",
      dagwrite: "allow",
      dagread: "allow",
      dagpatch: "allow",
      todowrite: "deny",
      todoread: "deny",
    }),
    ctx.user,
  )
}

export function createBuiltinPrimaryAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  return {
    [PrimaryAgentIdentity.names.general]: {
      name: PrimaryAgentIdentity.names.general,
      description:
        "Primary general-purpose orchestrator for the classic Synergy workflow. Plans, coordinates, executes, delegates to the legacy subagent set, verifies work, and handles user interaction across coding, writing, research, analysis, and operations.",
      prompt: "",
      options: {},
      permission: primaryPermission(ctx),
      mode: "primary",
      native: true,
    },
    [PrimaryAgentIdentity.names.coding]: {
      name: PrimaryAgentIdentity.names.coding,
      description:
        "Primary maximum-orchestration agent for the new coding-harness workflow. Acts as architect, planner, dispatcher, integrator, and quality controller over the expanded professional subagent system.",
      prompt: "",
      options: {},
      permission: primaryPermission(ctx),
      mode: "primary",
      native: true,
    },
    [PrimaryAgentIdentity.names.lightweight]: {
      name: PrimaryAgentIdentity.names.lightweight,
      description:
        "Primary lightweight general-purpose agent. Works hands-on with the classic execution surface and stays concise; orchestration tools (task delegation, DAG planning) stay folded behind expand_tools and are expanded only when the user asks for parallel work or the request is clearly a large multi-part task.",
      prompt: "",
      options: {},
      permission: primaryPermission(ctx),
      mode: "primary",
      native: true,
      deferredTools: ["task", "task_list", "task_output", "task_cancel", "dagwrite", "dagread", "dagpatch"],
    },
  }
}
