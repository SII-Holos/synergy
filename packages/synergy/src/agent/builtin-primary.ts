import { PermissionNext } from "@/permission/next"
import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"

function classicPrimaryPermission(ctx: BuiltinAgentContext): PermissionNext.Ruleset {
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
      view_file: "deny",
      revise_file: "deny",
      save_file: "deny",
      scan_files: "deny",
      parse_code: "deny",
      memory_write: "allow",
      memory_edit: "allow",
      ...(ctx.evolutionActive ? {} : { memory_search: "deny", memory_get: "deny" }),
    }),
    ctx.user,
  )
}

function maxPrimaryPermission(ctx: BuiltinAgentContext): PermissionNext.Ruleset {
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
      read: "deny",
      edit: "deny",
      write: "deny",
      grep: "deny",
      ast_grep: "deny",
      view_file: "allow",
      revise_file: "ask",
      save_file: "ask",
      scan_files: "allow",
      parse_code: "allow",
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
      permission: classicPrimaryPermission(ctx),
      mode: "primary",
      native: true,
    },
    "synergy-max": {
      name: "synergy-max",
      description:
        "Primary maximum-orchestration agent for the new coding-harness workflow. Acts as architect, planner, dispatcher, integrator, and quality controller over the expanded professional subagent system.",
      prompt: "",
      options: {},
      permission: maxPrimaryPermission(ctx),
      mode: "primary",
      native: true,
    },
  }
}
