import type { Info as SessionInfo } from "./types"
import { MessageV2 } from "./message-v2"

/**
 * WorkflowUserWrapper stamps and projects user messages for Plan, Lattice, and
 * Light Loop workflows. Stored messages carry compact workflow metadata; model
 * projection wraps only root user-origin text parts.
 */
export namespace WorkflowUserWrapper {
  export type Mode = "plan" | "lattice" | "lightloop"

  export const METADATA_MODE = "workflow"
  export const METADATA_AGENT = "workflowAgent"
  export const METADATA_VERSION = "workflowVersion"
  export const VERSION = 1

  const CONTROL_SOURCES = new Set([
    "blueprint_loop_start",
    "blueprint_loop_continuation",
    "blueprint_loop_rejected",
    "light_loop_continuation",
    "light_loop_approved",
    "light_loop_rejected",
    "lattice_continuation",
  ])

  const VALID_MODES = new Set<Mode>(["plan", "lattice", "lightloop"])

  type PromptBuilder = (query: string) => string
  type ModePromptBuilders = Record<Mode, PromptBuilder>

  const PROMPT_BUILDERS: Record<string, ModePromptBuilders> = {
    synergy: {
      plan: synergyPlan,
      lattice: synergyLattice,
      lightloop: synergyLightloop,
    },
    "synergy-max": {
      plan: synergyMaxPlan,
      lattice: synergyMaxLattice,
      lightloop: synergyMaxLightloop,
    },
  }

  const FALLBACK_BUILDERS: ModePromptBuilders = {
    plan: genericPlan,
    lattice: genericLattice,
    lightloop: genericLightloop,
  }

  export function activeMode(session?: Pick<SessionInfo, "workflow">): Mode | undefined {
    return session?.workflow?.kind
  }

  export function isRequestMetadata(metadata: Record<string, any> | undefined): boolean {
    if (!metadata) return false
    return typeof metadata[METADATA_MODE] === "string" && VALID_MODES.has(metadata[METADATA_MODE] as Mode)
  }

  export function stripReservedMetadata(metadata: Record<string, any> | undefined): Record<string, any> {
    if (!metadata) return {}
    const { [METADATA_MODE]: _mode, [METADATA_AGENT]: _agent, [METADATA_VERSION]: _version, ...rest } = metadata
    return rest
  }

  export function metadataForUserMessage(input: {
    session?: Pick<SessionInfo, "workflow">
    metadata?: Record<string, any>
    noReply?: boolean
    agentName: string
  }): Record<string, any> {
    const mode = activeMode(input.session)
    if (!mode) return {}
    if (input.noReply === true) return {}

    const source = input.metadata?.source
    if (typeof source === "string" && CONTROL_SOURCES.has(source)) return {}
    const hasExplicit = input.metadata?.[METADATA_MODE] === mode
    if (!hasExplicit && source !== undefined) return {}

    return {
      [METADATA_MODE]: mode,
      [METADATA_AGENT]: input.agentName,
      [METADATA_VERSION]: VERSION,
    }
  }

  export function projectMessages(input: {
    messages: MessageV2.WithParts[]
    session?: Pick<SessionInfo, "workflow">
    agent: { name: string }
  }): MessageV2.WithParts[] {
    return input.messages.map((msg) => {
      if (msg.info.role !== "user") return msg

      const mode = messageMode(msg)
      if (!mode) return msg

      const user = msg.info as MessageV2.User
      if (user.isRoot !== true || user.origin?.type !== "user") return msg

      const agentName = agentNameForMessage(msg, input.agent.name)
      let wrapped = false
      const parts = msg.parts.map((part) => {
        if (part.type !== "text") return part
        if (MessageV2.isSystemPart(part)) return part
        if (wrapped) return part
        wrapped = true
        return {
          ...part,
          text: build(agentName, mode, part.text),
        }
      })

      if (!wrapped) {
        parts.unshift({
          id: `${msg.info.id}_${mode}_workflow_wrapper`,
          sessionID: msg.info.sessionID,
          messageID: msg.info.id,
          type: "text",
          origin: "system",
          text: build(
            agentName,
            mode,
            "(The user request has no plain text. Use any attached context as the request.)",
          ),
        })
      }

      return { ...msg, parts }
    })
  }

  export function build(agentName: string, mode: Mode, query: string): string {
    const trimmed = query.trim() || "(empty request)"
    const builders = PROMPT_BUILDERS[agentName] ?? FALLBACK_BUILDERS
    return builders[mode](trimmed)
  }

  function messageMode(msg: MessageV2.WithParts): Mode | undefined {
    const md = msg.info.metadata as Record<string, any> | undefined
    const value = md?.[METADATA_MODE]
    if (typeof value === "string" && VALID_MODES.has(value as Mode)) return value as Mode
    return undefined
  }

  function agentNameForMessage(message: MessageV2.WithParts, fallback: string): string {
    const value = (message.info.metadata as Record<string, any> | undefined)?.[METADATA_AGENT]
    if (typeof value === "string" && value.trim()) return value.trim()
    return fallback
  }

  function genericPlan(query: string): string {
    return [
      "<plan-user-request>",
      "You are in the Plan workflow.",
      "Your task is to produce or refine a Blueprint, not deliver the user's requested outcome directly.",
      "Do not execute the requested outcome, edit project files, commit, push, deploy, or launch direct execution work.",
      "If the request is complex or underspecified, gather read-only context first and create a DAG or research/design subagents when that will improve the Blueprint.",
      "Before writing or updating a Blueprint, resolve blocking ambiguity; do not leave Open Decisions, Open Questions, TBDs, or user-owned execution choices for the execution session.",
      "",
      "User request:",
      query,
      "</plan-user-request>",
    ].join("\n")
  }

  function synergyPlan(query: string): string {
    return [
      "<plan-user-request>",
      "You are synergy in the Plan workflow.",
      "Your job is to create a new Blueprint or refine an existing Blueprint that captures the user's goal, reasoning, constraints, chosen approach, deliverables, and done criteria.",
      "Do not directly execute the requested task. Do not modify project files, commit, push, deploy, or perform external identity actions.",
      "Clarify the goal, identify missing information, and ask blocking questions before writing the Blueprint when any unresolved decision would affect the final outcome, domain approach, artifact shape, or acceptance criteria.",
      "For complex or underspecified work, use read-only investigation, research, DAGs, and appropriate specialist subagents to gather context, best practices, and known pitfalls before finalizing the Blueprint.",
      "Keep the Blueprint framed in the user's domain. Do not import another domain's specialized checklist unless the request actually belongs to that domain.",
      "The Blueprint should explain what to do, why, what to avoid, and what done looks like without leaving Open Decisions, Open Questions, TBDs, or choices for the execution session.",
      "",
      "User request:",
      query,
      "</plan-user-request>",
    ].join("\n")
  }

  function synergyMaxPlan(query: string): string {
    return [
      "<plan-user-request>",
      "You are synergy-max in the coding Plan workflow.",
      "Do not implement code. Do not edit files. Do not hand the task to implementation-engineer style execution while Plan is active.",
      "Your output should be a Blueprint strong enough for a later autonomous implementation session.",
      "Analyze the relevant codebase entry points, ownership boundaries, requirements, non-goals, verification approach, migrations/config/SDK/docs impact, risks, edge cases, rollback, and verification commands.",
      "If more context is needed, use read-only shell/code inspection and create DAGs or research/design/review subagents before writing or updating the Blueprint.",
      "The Blueprint should make the implementation sequence, verification expectations, and cleanup expectations unambiguous.",
      "Before writing or updating the Blueprint, ensure behavior, interfaces, migrations, compatibility choices, verification expectations, and acceptance criteria are resolved enough for implementation to start immediately.",
      "If an unresolved decision remains, ask the user instead of encoding it as an Open Decision, Open Question, TBD, or assumption.",
      "",
      "User request:",
      query,
      "</plan-user-request>",
    ].join("\n")
  }

  function genericLattice(query: string): string {
    return [
      "<lattice-user-request>",
      "You are in the Lattice workflow.",
      "Analyze the goal, plan an ordered Pathway, submit it with pathway_patch, and progress through each step.",
      "",
      "User request:",
      query,
      "</lattice-user-request>",
    ].join("\n")
  }

  function synergyLattice(query: string): string {
    return [
      "<lattice-user-request>",
      "You are synergy in the Lattice workflow.",
      "Analyze the user's goal, plan an ordered Pathway, submit it with pathway_patch, and progress through each step using the pathway tools.",
      "",
      "User request:",
      query,
      "</lattice-user-request>",
    ].join("\n")
  }

  function synergyMaxLattice(query: string): string {
    return [
      "<lattice-user-request>",
      "You are synergy-max in the Lattice workflow.",
      "Analyze the user's goal, plan an ordered Pathway, submit it with pathway_patch, and progress through each step using the pathway tools.",
      "",
      "User request:",
      query,
      "</lattice-user-request>",
    ].join("\n")
  }

  function genericLightloop(query: string): string {
    return [
      "<lightloop-user-request>",
      "You are in the Light Loop workflow.",
      "Complete the work thoroughly. Keep working until the task is fully done, then call loop_stop() to request a completion review.",
      "",
      "User request:",
      query,
      "</lightloop-user-request>",
    ].join("\n")
  }

  function synergyLightloop(query: string): string {
    return [
      "<lightloop-user-request>",
      "You are synergy in the Light Loop workflow.",
      "Complete the work thoroughly. Keep working and iterating until the task is fully done, then call loop_stop() to request a completion review.",
      "",
      "User request:",
      query,
      "</lightloop-user-request>",
    ].join("\n")
  }

  function synergyMaxLightloop(query: string): string {
    return [
      "<lightloop-user-request>",
      "You are synergy-max in the Light Loop workflow.",
      "Complete the work thoroughly. Keep working and iterating until the task is fully done, then call loop_stop() to request a completion review.",
      "",
      "User request:",
      query,
      "</lightloop-user-request>",
    ].join("\n")
  }
}
