import PROMPT_BOSS_SYNERGY from "./prompt/boss-synergy/base.txt"

import { PermissionNext } from "@/permission/next"
import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"

function classicPrimaryPermission(ctx: BuiltinAgentContext): PermissionNext.Ruleset {
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
      view_file: "deny",
      revise_file: "deny",
      resolve_conflicts: "deny",
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

function bossPrimaryPermission(ctx: BuiltinAgentContext): PermissionNext.Ruleset {
  return PermissionNext.merge(
    ctx.defaults,
    PermissionNext.fromConfig({
      "*": "deny",
      boss_spawn: "allow",
      boss_assign: "allow",
      boss_status: "allow",
      boss_cancel: "allow",
      boss_project: "allow",
      channel_push: "allow",
      session_control: "allow",
      session_send: "allow",
      session_read: "allow",
      session_list: "allow",
      session_search: "allow",
      scope_list: "allow",
      agenda_list: "allow",
      agenda_schedule: "allow",
      agenda_update: "allow",
      agenda_cancel: "allow",
      agenda_trigger: "allow",
      agenda_watch: "allow",
      agenda_logs: "allow",
      memory_get: "allow",
      memory_write: "allow",
      memory_edit: "allow",
      memory_search: "allow",
      note_list: "allow",
      note_read: "allow",
      note_search: "allow",
      note_write: "allow",
      note_edit: "allow",
      question: "allow",
      bash: "allow",
      process: "allow",
      task: "deny",
      task_list: "deny",
      task_output: "deny",
      task_cancel: "deny",
      view_file: "deny",
      revise_file: "deny",
      save_file: "deny",
      scan_files: "deny",
      parse_code: "deny",
      read: "deny",
      edit: "deny",
      write: "deny",
      grep: "deny",
      ast_grep: "deny",
      runtime_reload: "deny",
      dagwrite: "deny",
      dagread: "deny",
      dagpatch: "deny",
      note_archive: "deny",
      note_delete: "deny",
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
      resolve_conflicts: "ask",
      save_file: "ask",
      scan_files: "allow",
      parse_code: "allow",
      scan_document: "allow",
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
    "boss-synergy": {
      name: "boss-synergy",
      description:
        "Primary coordination-only agent for Runtime Boss Mode. Dispatches and checks worker and project-boss sessions, creates projects, and replies over channels; never executes tasks itself, never spawns subagents, and never edits files.",
      prompt: PROMPT_BOSS_SYNERGY,
      options: {},
      permission: bossPrimaryPermission(ctx),
      mode: "primary",
      native: true,
      // Hidden host-owned agent: not shown in agent menus or the Settings
      // default-agent selector, and never selectable for ordinary sessions.
      // It is only reachable through the boss session agentOverride.
      hidden: true,
    },
  }
}
