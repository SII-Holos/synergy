import type { Info as SessionInfo } from "./types"
import { MessageV2 } from "./message-v2"
import { SessionModePolicy } from "./tool-mode-policy"

export namespace PlanModeUserWrapper {
  export const METADATA_REQUEST = "planModeRequest"
  export const METADATA_AGENT = "planModeAgent"
  export const METADATA_VERSION = "planModeWrapperVersion"
  export const VERSION = 1

  const CONTROL_SOURCES = new Set(["blueprint_loop_start", "blueprint_loop_continuation", "blueprint_loop_restart"])

  type PromptBuilder = (query: string) => string

  const PROMPT_BUILDERS: Record<string, PromptBuilder> = {
    synergy,
    "synergy-max": synergyMax,
  }

  export function isRequestMetadata(metadata: Record<string, any> | undefined): boolean {
    return metadata?.[METADATA_REQUEST] === true
  }

  export function stripReservedMetadata(metadata: Record<string, any> | undefined): Record<string, any> {
    if (!metadata) return {}
    const { [METADATA_REQUEST]: _request, [METADATA_AGENT]: _agent, [METADATA_VERSION]: _version, ...rest } = metadata
    return rest
  }

  export function metadataForUserMessage(input: {
    session?: Pick<SessionInfo, "blueprint">
    metadata?: Record<string, any>
    noReply?: boolean
    agentName: string
  }): Record<string, any> {
    if (!SessionModePolicy.isPlanMode(input.session)) return {}
    if (input.noReply === true) return {}
    if (input.metadata?.[METADATA_REQUEST] === false) return {}
    if (input.metadata?.synthetic === true) return {}

    const source = input.metadata?.source
    if (typeof source === "string" && CONTROL_SOURCES.has(source)) return {}
    if (input.metadata?.[METADATA_REQUEST] !== true && source !== undefined) return {}

    return {
      [METADATA_REQUEST]: true,
      [METADATA_AGENT]: input.agentName,
      [METADATA_VERSION]: VERSION,
    }
  }

  export function projectMessages(input: {
    messages: MessageV2.WithParts[]
    session?: Pick<SessionInfo, "blueprint">
    agent: { name: string }
  }): MessageV2.WithParts[] {
    if (!SessionModePolicy.isPlanMode(input.session)) return input.messages

    return input.messages.map((msg) => {
      if (msg.info.role !== "user") return msg
      if (!isRequestMetadata(msg.info.metadata as Record<string, any> | undefined)) return msg

      const agentName = agentNameForMessage(msg, input.agent.name)
      let wrapped = false
      const parts = msg.parts.map((part) => {
        if (part.type !== "text" || part.ignored || part.synthetic) return part
        if (wrapped) return part
        wrapped = true
        return {
          ...part,
          text: build(agentName, part.text),
        }
      })

      if (!wrapped) {
        parts.unshift({
          id: `${msg.info.id}_plan_mode_wrapper`,
          sessionID: msg.info.sessionID,
          messageID: msg.info.id,
          type: "text",
          synthetic: true,
          text: build(agentName, "(The user request has no plain text. Use any attached context as the request.)"),
        })
      }

      return { ...msg, parts }
    })
  }

  export function build(agentName: string, query: string): string {
    const trimmed = query.trim() || "(empty request)"
    return (PROMPT_BUILDERS[agentName] ?? generic)(trimmed)
  }

  function agentNameForMessage(message: MessageV2.WithParts, fallback: string): string {
    const value = (message.info.metadata as Record<string, any> | undefined)?.[METADATA_AGENT]
    return typeof value === "string" && value.trim() ? value.trim() : fallback
  }

  function generic(query: string): string {
    return [
      "<plan-mode-user-request>",
      "You are in Plan Mode.",
      "Your task is to produce or refine a Blueprint, not execute the user's task directly.",
      "Do not implement, edit project files, commit, push, deploy, or launch direct implementation work.",
      "If the request is complex or underspecified, gather read-only context first and create a DAG or research/design subagents when that will improve the Blueprint.",
      "",
      "User request:",
      query,
      "</plan-mode-user-request>",
    ].join("\n")
  }

  function synergy(query: string): string {
    return [
      "<plan-mode-user-request>",
      "You are synergy in Plan Mode.",
      "Your job is to create a new Blueprint or refine an existing Blueprint that captures the user's goal, reasoning, constraints, and execution plan.",
      "Do not directly execute the requested task. Do not modify project implementation files, commit, push, deploy, or perform external identity actions.",
      "Clarify the goal, identify missing information, and ask blocking questions when needed.",
      "For complex or underspecified work, use read-only investigation, research, DAGs, and research/design subagents to gather context, best practices, and known pitfalls before finalizing the Blueprint.",
      "The Blueprint should explain what to do, why, what to avoid, and what done looks like.",
      "",
      "User request:",
      query,
      "</plan-mode-user-request>",
    ].join("\n")
  }

  function synergyMax(query: string): string {
    return [
      "<plan-mode-user-request>",
      "You are synergy-max in coding Plan Mode.",
      "Do not implement code. Do not edit files. Do not hand the task to implementation-engineer style execution while Plan Mode is active.",
      "Your output should be a Blueprint strong enough for a later autonomous implementation session.",
      "Analyze the relevant codebase entry points, ownership boundaries, requirements, non-goals, TDD strategy, migrations/config/SDK/docs impact, risks, edge cases, rollback, and verification commands.",
      "If more context is needed, use read-only shell/code inspection and create DAGs or research/design/review subagents before writing or updating the Blueprint.",
      "The Blueprint should make the implementation sequence, tests, quality gates, and cleanup expectations unambiguous.",
      "",
      "User request:",
      query,
      "</plan-mode-user-request>",
    ].join("\n")
  }
}
