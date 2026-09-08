import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { INTENT_MAX_CHARS } from "./encoder-constants"
import type { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import PROMPT_CHRONICLER from "./prompts/chronicler.txt"
import PROMPT_INTENT from "./prompts/intent.txt"
import PROMPT_REWARD from "./prompts/reward.txt"
import PROMPT_SCRIPT from "./prompts/script.txt"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"

export function createDomainAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  return {
    chronicler: {
      name: "chronicler",
      mode: "primary",
      native: true,
      hidden: true,
      prompt: PROMPT_CHRONICLER,
      permission: PermissionNext.merge(
        ctx.defaults,
        PermissionNext.fromConfig({
          "*": "deny",
          read: "allow",
          grep: "allow",
          glob: "allow",
          memory_write: "allow",
          memory_edit: "allow",
          memory_search: "allow",
          memory_get: "allow",
          note_list: "allow",
          note_read: "allow",
          note_search: "allow",
          note_write: "allow",
          note_edit: "allow",
          session_list: "allow",
          session_read: "allow",
          session_send: "allow",
        }),
        ctx.user,
      ),
      options: {},
      ...resolveAgentModelRole(ctx, "long"),
    },
    intent: {
      name: "intent",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      permission: PermissionNext.merge(ctx.defaults, PermissionNext.fromConfig({ "*": "deny" }), ctx.user),
      prompt: PROMPT_INTENT.replace("__INTENT_LIMIT__", String(INTENT_MAX_CHARS)),
      ...resolveAgentModelRole(ctx, "mini"),
    },
    script: {
      name: "script",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      permission: PermissionNext.merge(ctx.defaults, PermissionNext.fromConfig({ "*": "deny" }), ctx.user),
      prompt: PROMPT_SCRIPT,
      ...resolveAgentModelRole(ctx, "mini"),
    },
    reward: {
      name: "reward",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      permission: PermissionNext.merge(ctx.defaults, PermissionNext.fromConfig({ "*": "deny" }), ctx.user),
      prompt: PROMPT_REWARD,
      ...resolveAgentModelRole(ctx, "mini"),
    },
  }
}

export function registerLibraryAgents() {
  AgentBuiltins.register("library", createDomainAgents)
}
