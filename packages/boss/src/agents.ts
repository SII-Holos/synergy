import { registerBossPrompts } from "./agent-prompts"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import type { BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import PROMPT from "./prompts/boss-synergy.txt"
function bossPrimaryPermission(ctx: BuiltinAgentContext): PermissionNext.Ruleset {
  return PermissionNext.merge(
    ctx.defaults,
    PermissionNext.fromConfig({
      "*": "deny",
      search_tools: "allow",
      expand_tools: "allow",
      boss_spawn: "allow",
      boss_assign: "allow",
      boss_status: "allow",
      boss_cancel: "allow",
      boss_project: "allow",
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
    }),
    ctx.user,
  )
}

export function registerAgents() {
  registerBossPrompts()
  AgentBuiltins.register("boss", (ctx) => ({
    "boss-synergy": {
      name: "boss-synergy",
      description:
        "Primary coordination agent for Runtime Boss Mode. Dispatches and checks worker and project-boss sessions and creates projects.",
      prompt: PROMPT,
      options: {},
      permission: bossPrimaryPermission(ctx),
      mode: "primary",
      native: true,
      hidden: true,
    },
  }))
}
