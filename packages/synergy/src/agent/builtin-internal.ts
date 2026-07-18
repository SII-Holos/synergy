import { PermissionNext } from "@/permission/next"
import { INTENT_MAX_CHARS } from "../library/encoder-constants"
import type { Agent } from "./agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "./builtin-context"
import PROMPT_ANIMA from "./prompt/anima.txt"
import PROMPT_CHRONICLER from "./prompt/chronicler.txt"
import PROMPT_AGENT_GENERATE from "./generate.txt"
import { buildCompactionPrompt } from "./prompt/compaction/builder"
import { createPerformanceAnalystAgent } from "./prompt/performance-analyst/builder"
import PROMPT_INTENT from "./prompt/intent.txt"
import PROMPT_MULTIMODAL_LOOKER from "./prompt/multimodal-looker.txt"
import PROMPT_REWARD from "./prompt/reward.txt"
import PROMPT_SCRIPT from "./prompt/script.txt"
import PROMPT_SMART_ALLOW from "./prompt/smart-allow.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"

export function createBuiltinInternalAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  const performanceAnalyst = createPerformanceAnalystAgent(ctx)
  return {
    [performanceAnalyst.name]: performanceAnalyst,
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
    anima: {
      name: "anima",
      description:
        "Autonomous inner self that runs periodic routines — reflects on recent activity, organizes knowledge, plans agenda tasks, engages with the community on Agora, and explores the web to learn. Not a user-facing agent; runs as a background daily routine.",
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
          arxiv_search: "allow",
          arxiv_download: "allow",
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
