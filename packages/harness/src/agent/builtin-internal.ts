import { PermissionNext } from "../permission/next"
import type { Agent } from "./agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "./builtin-context"
import PROMPT_AGENT_GENERATE from "./generate.txt"
import { buildCompactionPrompt } from "./prompt/compaction/builder"
import PROMPT_SMART_ALLOW from "./prompt/smart-allow.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"

export function createBuiltinInternalAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  return {
    compaction: {
      name: "compaction",
      mode: "primary",
      native: true,
      hidden: true,
      prompt: buildCompactionPrompt(),
      permission: PermissionNext.merge(ctx.defaults, PermissionNext.fromConfig({ "*": "deny" }), ctx.user),
      options: {},
      ...resolveAgentModelRole(ctx, "long"),
    },
    title: {
      name: "title",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      temperature: 0.5,
      permission: PermissionNext.merge(ctx.defaults, PermissionNext.fromConfig({ "*": "deny" }), ctx.user),
      prompt: PROMPT_TITLE,
      ...resolveAgentModelRole(ctx, "nano"),
    },
    summary: {
      name: "summary",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      permission: PermissionNext.merge(ctx.defaults, PermissionNext.fromConfig({ "*": "deny" }), ctx.user),
      prompt: PROMPT_SUMMARY,
      ...resolveAgentModelRole(ctx, "nano"),
    },
    "smart-allow": {
      name: "smart-allow",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      temperature: 0,
      permission: PermissionNext.fromConfig({ "*": "deny" }),
      prompt: PROMPT_SMART_ALLOW,
      ...resolveAgentModelRole(ctx, "mid"),
    },
    "agent-generator": {
      name: "agent-generator",
      mode: "primary",
      options: {},
      native: true,
      hidden: true,
      temperature: 0.3,
      permission: PermissionNext.fromConfig({ "*": "deny" }),
      prompt: PROMPT_AGENT_GENERATE,
      ...resolveAgentModelRole(ctx, "mini"),
    },
  }
}
