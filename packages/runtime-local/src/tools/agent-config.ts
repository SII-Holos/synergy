import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
import { AgentConfig } from "@ericsanchezok/synergy-harness/agent/config-crud"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import DESCRIPTION from "./agent-config.txt"

const parameters = z.object({
  input: z
    .discriminatedUnion("action", [
      AgentConfig.Input.Create,
      AgentConfig.Input.Update,
      AgentConfig.Input.Remove,
      AgentConfig.Input.SetDefault,
      AgentConfig.Input.Describe,
      AgentConfig.Input.List,
    ])
    .describe("One action object. create/update/remove/set_default/describe each take agent fields; list takes none."),
})
type ActionInput = z.infer<(typeof parameters)["shape"]["input"]>

interface AgentConfigMetadata {
  action: string
  name?: string
  source?: AgentConfig.OwnerLayer
  file?: string
  count?: number
  default_agent?: string
  strategy?: AgentConfig.RemoveStrategy
  agent?: Record<string, unknown>
  [key: string]: unknown
}

export const AgentConfigToolGroup: ToolExposure.GroupInfo = {
  id: "agent-config",
  title: "Agent configuration",
  description:
    "Create, update, disable, delete, inspect, and set the default agent through validated agent_config writes (markdown agent files or 60-agents.jsonc entries).",
  whenToExpand:
    'Expand with expand_tools({ groups: ["agent-config"] }) when the user wants to create or customize an agent, change an agent\'s model/prompt/permissions/visibility, disable or remove an agent, or change the default agent.',
  tools: ["agent_config"],
}

const MAX_PERMISSION_RULES = 20
const MAX_PROMPT_CHARS = 500

/** Bounded structured projection of the resolved agent for tool metadata. */
function projectAgent(agent: Agent.Info): Record<string, unknown> {
  return {
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    native: agent.native,
    hidden: agent.hidden,
    model: agent.model,
    modelRole: agent.modelRole,
    modelSource: agent.modelSource,
    temperature: agent.temperature,
    topP: agent.topP,
    steps: agent.steps,
    color: agent.color,
    controlProfile: agent.controlProfile,
    visibleTo: agent.visibleTo,
    delegationGroups: agent.delegationGroups,
    deferredTools: agent.deferredTools,
    defaultVariant: agent.defaultVariant,
    promptPreview:
      agent.prompt === undefined
        ? undefined
        : agent.prompt.length > MAX_PROMPT_CHARS
          ? agent.prompt.slice(0, MAX_PROMPT_CHARS) + "…"
          : agent.prompt,
    permissionRules: agent.permission
      .slice(0, MAX_PERMISSION_RULES)
      .map((rule) => ({ permission: rule.permission, pattern: rule.pattern, action: rule.action })),
    permissionRulesTruncated: agent.permission.length > MAX_PERMISSION_RULES,
  }
}

function summarizeAgent(item: AgentConfig.Describe): string {
  const lines = [
    `${item.agent.name} (${item.agent.mode}${item.agent.native ? ", built-in" : ""})`,
    item.agent.description ? `  ${item.agent.description}` : undefined,
    `  defined by: ${item.source}${item.file ? ` (${item.file})` : ""}`,
    item.agent.model ? `  model: ${item.agent.model.providerID}/${item.agent.model.modelID}` : undefined,
    item.agent.controlProfile ? `  control profile: ${item.agent.controlProfile}` : undefined,
    item.agent.visibleTo?.length ? `  visible to: ${item.agent.visibleTo.join(", ")}` : undefined,
    item.agent.hidden ? "  hidden from menus" : undefined,
  ]
  return lines.filter(Boolean).join("\n")
}

export const AgentConfigTool = Tool.define<typeof parameters, AgentConfigMetadata>("agent_config", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const input: ActionInput = params.input

    try {
      switch (input.action) {
        case "create": {
          const { action, name, storage, scope, ...entry } = input
          const result = await AgentConfig.create({ name, ...entry, storage, scope, signal: ctx.abort })
          const location = result.source + (result.file ? `: ${result.file}` : "")
          const body = result.agent
            ? summarizeAgent({ agent: result.agent, source: result.source, file: result.file })
            : "  file written outside the scanned config directories; move it into .synergy/agent/ or the global config to activate it."
          const lines = [`Agent "${result.name}" created (${location}).`, "", body]
          return {
            title: `Create agent ${result.name}`,
            metadata: {
              action,
              name: result.name,
              source: result.source,
              file: result.file,
              agent: result.agent ? projectAgent(result.agent) : undefined,
            },
            output: lines.join("\n"),
          }
        }
        case "update": {
          const { action, name, ...patch } = input
          const result = await AgentConfig.update({ name, patch, signal: ctx.abort })
          const lines = [
            `Agent "${result.name}" ${result.agent ? "updated" : "disabled"} (${result.source}${result.file ? `: ${result.file}` : ""}).`,
            "",
            result.agent
              ? summarizeAgent({ ...result, agent: result.agent })
              : "Re-enable with update { disable: false }.",
          ]
          return {
            title: `Update agent ${result.name}`,
            metadata: {
              action,
              name: result.name,
              source: result.source,
              file: result.file,
              agent: result.agent ? projectAgent(result.agent) : undefined,
            },
            output: lines.join("\n"),
          }
        }
        case "remove": {
          const { action, ...rest } = input
          const result = await AgentConfig.remove({ name: rest.name, strategy: rest.strategy, signal: ctx.abort })
          return {
            title: `${result.strategy === "delete" ? "Delete" : "Disable"} agent ${result.name}`,
            metadata: { action, ...result },
            output:
              result.strategy === "disable"
                ? `Agent "${result.name}" disabled (disable: true written in the owning layer). Re-enable with update { disable: false }.`
                : `Agent "${result.name}" deleted — its defining file and config entries were removed.`,
          }
        }
        case "set_default": {
          const { action, ...rest } = input
          const result = await AgentConfig.setDefault(rest.name, ctx.abort)
          return {
            title: `Set default agent ${result.default_agent}`,
            metadata: { action, ...result },
            output: `default_agent is now "${result.default_agent}". New sessions without an explicit agent will use it.`,
          }
        }
        case "describe": {
          const { action, ...rest } = input
          const result = await AgentConfig.describe(rest.name)
          return {
            title: `Agent ${result.agent.name}`,
            metadata: {
              action,
              name: result.agent.name,
              source: result.source,
              file: result.file,
              agent: projectAgent(result.agent),
            },
            output: `${summarizeAgent(result)}

${JSON.stringify(projectAgent(result.agent), null, 2)}`,
          }
        }
        case "list": {
          const agents = await AgentConfig.list()
          const lines = agents.map(summarizeAgent)
          return {
            title: `${agents.length} agents`,
            metadata: { action: "list", count: agents.length },
            output:
              lines.length > 0
                ? lines.join("\n\n")
                : "No agents found. This is unexpected — built-in agents should always be present; check server logs.",
          }
        }
        default: {
          const exhaustive: never = input
          throw new Error(`unknown agent_config action: ${(exhaustive as { action?: string })?.action}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`agent_config ${input.action} failed: ${message}`)
    }
  },
})
