import { PermissionNext } from "@/permission/next"
import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"

function primaryPermission(ctx: BuiltinAgentContext): PermissionNext.Ruleset {
  return PermissionNext.merge(
    ctx.defaults,
    PermissionNext.fromConfig({
      question: "allow",
      arxiv_search: "allow",
      arxiv_download: "allow",
      runtime_reload: "allow",
      dagwrite: "allow",
      dagread: "allow",
      dagpatch: "allow",
      todowrite: "deny",
      todoread: "deny",
      memory_write: "allow",
      memory_edit: "allow",
      ...(ctx.evolutionActive ? {} : { memory_search: "deny", memory_get: "deny" }),
    }),
    ctx.user,
  )
}

export function createBuiltinPrimaryAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  return {
    synergy: {
      name: "synergy",
      description:
        "Primary general-purpose orchestrator for the classic Synergy workflow. Plans, coordinates, executes, delegates to the legacy subagent set, verifies work, and handles user interaction across coding, writing, research, analysis, and operations.",
      prompt: "",
      options: {},
      permission: primaryPermission(ctx),
      mode: "primary",
      native: true,
    },
    "synergy-max": {
      name: "synergy-max",
      description:
        "Primary maximum-orchestration agent for the new coding-harness workflow. Acts as architect, planner, dispatcher, integrator, and quality controller over the expanded professional subagent system.",
      prompt: "",
      options: {},
      permission: primaryPermission(ctx),
      mode: "primary",
      native: true,
    },
  }
}
