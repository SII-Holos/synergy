import type { Info as SessionInfo } from "./types"
import { MessageV2 } from "./message-v2"

/**
 * WorkflowModeUserWrapper — unified user-message injection for Plan, Lattice,
 * and Light Loop modes. When a mode is active, outgoing user messages carry mode
 * metadata and their text is wrapped with mode-specific guidance so the LLM
 * knows which workflow contract to follow.
 *
 * Extensible: per-agent prompt builders are registered in PROMPT_BUILDERS (one
 * record of Mode → PromptBuilder per agent name). Unknown agents fall back to
 * FALLBACK_BUILDERS.
 */
export namespace WorkflowModeUserWrapper {
  export type Mode = "plan" | "lattice" | "light_loop"

  export const METADATA_MODE = "workflowMode"
  export const METADATA_AGENT = "workflowModeAgent"
  export const METADATA_VERSION = "workflowModeVersion"
  export const VERSION = 1

  // Legacy Plan Mode metadata keys — kept so old stored messages still parse.
  const LEGACY_PLAN_MODE_REQUEST = "planModeRequest"
  const LEGACY_PLAN_MODE_AGENT = "planModeAgent"
  const LEGACY_PLAN_MODE_VERSION = "planModeWrapperVersion"

  /** System-injected messages that must NOT be wrapped by any workflow mode. */
  const CONTROL_SOURCES = new Set([
    "blueprint_loop_start",
    "blueprint_loop_continuation",
    "blueprint_loop_restart",
    "light_loop_continuation",
    "lattice_continuation",
  ])

  const VALID_MODES = new Set<Mode>(["plan", "lattice", "light_loop"])

  type PromptBuilder = (query: string) => string
  type ModePromptBuilders = Record<Mode, PromptBuilder>

  // ---- per-agent, per-mode prompt builders ----

  const PROMPT_BUILDERS: Record<string, ModePromptBuilders> = {
    synergy: {
      plan: synergyPlan,
      lattice: synergyLattice,
      light_loop: synergyLightLoop,
    },
    "synergy-max": {
      plan: synergyMaxPlan,
      lattice: synergyMaxLattice,
      light_loop: synergyMaxLightLoop,
    },
  }

  const FALLBACK_BUILDERS: ModePromptBuilders = {
    plan: genericPlan,
    lattice: genericLattice,
    light_loop: genericLightLoop,
  }

  // ---- active mode detection ----

  export function activeMode(session?: Pick<SessionInfo, "planMode" | "lattice" | "lightLoop">): Mode | undefined {
    if (session?.planMode === true) return "plan"
    if (session?.lattice) return "lattice"
    if (session?.lightLoop?.active) return "light_loop"
    return undefined
  }

  // ---- metadata ----

  /** True when this message's metadata identifies it as a workflow-mode message
   *  (new `workflowMode` key or legacy `planModeRequest` key). */
  export function isRequestMetadata(metadata: Record<string, any> | undefined): boolean {
    if (!metadata) return false
    if (typeof metadata[METADATA_MODE] === "string" && VALID_MODES.has(metadata[METADATA_MODE] as Mode)) return true
    return metadata[LEGACY_PLAN_MODE_REQUEST] === true
  }

  /** Strip workflow-mode metadata before persisting external metadata. */
  export function stripReservedMetadata(metadata: Record<string, any> | undefined): Record<string, any> {
    if (!metadata) return {}
    const {
      [METADATA_MODE]: _mode,
      [METADATA_AGENT]: _agent,
      [METADATA_VERSION]: _version,
      [LEGACY_PLAN_MODE_REQUEST]: _legacyReq,
      [LEGACY_PLAN_MODE_AGENT]: _legacyAgent,
      [LEGACY_PLAN_MODE_VERSION]: _legacyVersion,
      ...rest
    } = metadata
    return rest
  }

  /** Stamp workflow-mode metadata on a new user message when the session has an
   *  active mode. Returns {} when no mode is active, the message is noReply, or
   *  the message source belongs to the control white-list. */
  export function metadataForUserMessage(input: {
    session?: Pick<SessionInfo, "planMode" | "lattice" | "lightLoop">
    metadata?: Record<string, any>
    noReply?: boolean
    agentName: string
  }): Record<string, any> {
    const mode = activeMode(input.session)
    if (!mode) return {}
    if (input.noReply === true) return {}

    const source = input.metadata?.source
    if (typeof source === "string" && CONTROL_SOURCES.has(source)) return {}
    // Sourced messages (mailbox, cortex, etc.) are only wrapped when the caller
    // explicitly opts in via the mode metadata key.
    const hasExplicit = input.metadata?.[METADATA_MODE] === mode
    if (!hasExplicit && source !== undefined) return {}
    // Backward compat: legacy explicit opt-in
    if (!hasExplicit && input.metadata?.[LEGACY_PLAN_MODE_REQUEST] !== true && source !== undefined) return {}

    return {
      [METADATA_MODE]: mode,
      [METADATA_AGENT]: input.agentName,
      [METADATA_VERSION]: VERSION,
    }
  }

  // ---- message projection ----

  /** Wrap user-message text with mode-specific guidance for the LLM
   *  (does NOT mutate the stored message). */
  export function projectMessages(input: {
    messages: MessageV2.WithParts[]
    session?: Pick<SessionInfo, "planMode" | "lattice" | "lightLoop">
    agent: { name: string }
  }): MessageV2.WithParts[] {
    return input.messages.map((msg) => {
      if (msg.info.role !== "user") return msg

      const mode = messageMode(msg)
      if (!mode) return msg

      // Wrap only root user-origin messages (spec §4.2).
      // Fall back to old metadata check for unmigrated sessions.
      const user = msg.info as MessageV2.User
      const shouldWrap =
        user.isRoot !== undefined && user.origin !== undefined
          ? user.isRoot === true && user.origin.type === "user"
          : isRequestMetadata(msg.info.metadata as Record<string, any> | undefined)
      if (!shouldWrap) return msg

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
          id: `${msg.info.id}_${mode}_mode_wrapper`,
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

  // ---- prompt building ----

  export function build(agentName: string, mode: Mode, query: string): string {
    const trimmed = query.trim() || "(empty request)"
    const builders = PROMPT_BUILDERS[agentName] ?? FALLBACK_BUILDERS
    return builders[mode](trimmed)
  }

  // ---- helpers ----

  function messageMode(msg: MessageV2.WithParts): Mode | undefined {
    const md = msg.info.metadata as Record<string, any> | undefined
    if (!md) return undefined
    // New metadata
    const v = md[METADATA_MODE]
    if (typeof v === "string" && VALID_MODES.has(v as Mode)) return v as Mode
    // Backward compat
    if (md[LEGACY_PLAN_MODE_REQUEST] === true) return "plan"
    return undefined
  }

  function agentNameForMessage(message: MessageV2.WithParts, fallback: string): string {
    const md = message.info.metadata as Record<string, any> | undefined
    // New metadata first
    const value = md?.[METADATA_AGENT]
    if (typeof value === "string" && value.trim()) return value.trim()
    // Backward compat
    const legacy = md?.[LEGACY_PLAN_MODE_AGENT]
    if (typeof legacy === "string" && legacy.trim()) return legacy.trim()
    return fallback
  }

  // ===================================================================
  //  Prompt builders — Plan Mode (copied from original wrapper)
  // ===================================================================

  function genericPlan(query: string): string {
    return [
      "<plan-mode-user-request>",
      "You are in Plan Mode.",
      "Your task is to produce or refine a Blueprint, not deliver the user's requested outcome directly.",
      "Do not execute the requested outcome, edit project files, commit, push, deploy, or launch direct execution work.",
      "If the request is complex or underspecified, gather read-only context first and create a DAG or research/design subagents when that will improve the Blueprint.",
      "Before writing or updating a Blueprint, resolve blocking ambiguity; do not leave Open Decisions, Open Questions, TBDs, or user-owned execution choices for the execution session.",
      "",
      "User request:",
      query,
      "</plan-mode-user-request>",
    ].join("\n")
  }

  function synergyPlan(query: string): string {
    return [
      "<plan-mode-user-request>",
      "You are synergy in Plan Mode.",
      "Your job is to create a new Blueprint or refine an existing Blueprint that captures the user's goal, reasoning, constraints, chosen approach, deliverables, and done criteria.",
      "Do not directly execute the requested task. Do not modify project files, commit, push, deploy, or perform external identity actions.",
      "Clarify the goal, identify missing information, and ask blocking questions before writing the Blueprint when any unresolved decision would affect the final outcome, domain approach, artifact shape, or acceptance criteria.",
      "For complex or underspecified work, use read-only investigation, research, DAGs, and appropriate specialist subagents to gather context, best practices, and known pitfalls before finalizing the Blueprint.",
      "Keep the Blueprint framed in the user's domain. Do not import another domain's specialized checklist unless the request actually belongs to that domain.",
      "The Blueprint should explain what to do, why, what to avoid, and what done looks like without leaving Open Decisions, Open Questions, TBDs, or choices for the execution session.",
      "",
      "User request:",
      query,
      "</plan-mode-user-request>",
    ].join("\n")
  }

  function synergyMaxPlan(query: string): string {
    return [
      "<plan-mode-user-request>",
      "You are synergy-max in coding Plan Mode.",
      "Do not implement code. Do not edit files. Do not hand the task to implementation-engineer style execution while Plan Mode is active.",
      "Your output should be a Blueprint strong enough for a later autonomous implementation session.",
      "Analyze the relevant codebase entry points, ownership boundaries, requirements, non-goals, verification approach, migrations/config/SDK/docs impact, risks, edge cases, rollback, and verification commands.",
      "If more context is needed, use read-only shell/code inspection and create DAGs or research/design/review subagents before writing or updating the Blueprint.",
      "The Blueprint should make the implementation sequence, verification expectations, and cleanup expectations unambiguous.",
      "Before writing or updating the Blueprint, ensure behavior, interfaces, migrations, compatibility choices, verification expectations, and acceptance criteria are resolved enough for implementation to start immediately.",
      "If an unresolved decision remains, ask the user instead of encoding it as an Open Decision, Open Question, TBD, or assumption.",
      "",
      "User request:",
      query,
      "</plan-mode-user-request>",
    ].join("\n")
  }

  // ===================================================================
  //  Prompt builders — Lattice Mode (simple stubs)
  // ===================================================================

  function genericLattice(query: string): string {
    return [
      "<lattice-mode-user-request>",
      "You are in Lattice Mode.",
      "Follow Lattice-mode behavior: analyze the goal, plan an ordered Pathway, submit it with pathway_patch, and progress through each step.",
      "",
      "User request:",
      query,
      "</lattice-mode-user-request>",
    ].join("\n")
  }

  function synergyLattice(query: string): string {
    return [
      "<lattice-mode-user-request>",
      "You are synergy in Lattice Mode.",
      "Follow Lattice-mode behavior: analyze the user's goal, plan an ordered Pathway, submit it with pathway_patch, and progress through each step using the pathway tools.",
      "",
      "User request:",
      query,
      "</lattice-mode-user-request>",
    ].join("\n")
  }

  function synergyMaxLattice(query: string): string {
    return [
      "<lattice-mode-user-request>",
      "You are synergy-max in Lattice Mode.",
      "Follow Lattice-mode behavior: analyze the user's goal, plan an ordered Pathway, submit it with pathway_patch, and progress through each step using the pathway tools.",
      "",
      "User request:",
      query,
      "</lattice-mode-user-request>",
    ].join("\n")
  }

  // ===================================================================
  //  Prompt builders — Light Loop Mode (simple stubs)
  // ===================================================================

  function genericLightLoop(query: string): string {
    return [
      "<light-loop-mode-user-request>",
      "You are in Light Loop mode.",
      "Your task is to complete the work thoroughly. Keep working until the task is fully done, then call loop_stop().",
      "",
      "User request:",
      query,
      "</light-loop-mode-user-request>",
    ].join("\n")
  }

  function synergyLightLoop(query: string): string {
    return [
      "<light-loop-mode-user-request>",
      "You are synergy in Light Loop mode.",
      "Your task is to complete the work thoroughly. Keep working and iterating until the task is fully done, then call loop_stop().",
      "",
      "User request:",
      query,
      "</light-loop-mode-user-request>",
    ].join("\n")
  }

  function synergyMaxLightLoop(query: string): string {
    return [
      "<light-loop-mode-user-request>",
      "You are synergy-max in Light Loop mode.",
      "Your task is to complete the work thoroughly. Keep working and iterating until the task is fully done, then call loop_stop().",
      "",
      "User request:",
      query,
      "</light-loop-mode-user-request>",
    ].join("\n")
  }
}
