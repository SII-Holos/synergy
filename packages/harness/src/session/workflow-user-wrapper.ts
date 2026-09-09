import type { Info as SessionInfo } from "./types"
import { MessageV2 } from "./message-v2"
import { WorkflowPromptRegistry } from "./workflow-prompt-registry"
import { WorkflowKindRegistry } from "./workflow-kind-registry"

/**
 * WorkflowUserWrapper stamps and projects user messages for Plan, Lattice, and
 * Light Loop workflows. Stored messages carry compact workflow metadata; model
 * projection wraps only root user-origin text parts.
 */
export namespace WorkflowUserWrapper {
  /** Core workflow kinds kept as a closed literal union for narrowing. */
  export type Mode = string

  export const METADATA_MODE = "workflow"
  export const METADATA_AGENT = "workflowAgent"
  export const METADATA_VERSION = "workflowVersion"
  export const VERSION = 1

  function knownMode(value: string): boolean {
    return WorkflowPromptRegistry.get(value) !== undefined || WorkflowKindRegistry.get(value) !== undefined
  }

  export function activeMode(session?: Pick<SessionInfo, "workflow">): string | undefined {
    const workflow = session?.workflow
    const kind = WorkflowKindRegistry.effectiveKind(workflow)
    if (!kind || !knownMode(kind)) return undefined
    if (session && WorkflowPromptRegistry.get(kind)?.acceptsUserRequest?.(session) === false) return undefined
    return kind
  }

  export function isRequestMetadata(metadata: Record<string, any> | undefined): boolean {
    if (!metadata) return false
    return typeof metadata[METADATA_MODE] === "string" && knownMode(metadata[METADATA_MODE])
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
    if (typeof source === "string" && WorkflowPromptRegistry.controlSources().has(source)) return {}
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

  /** Build the wrapper for a workflow kind. Core `plan` keeps its in-module
   * builders; every registered domain kind (lattice/boss/lightloop and H3
   * extension kinds) resolves through the prompt registry — without
   * registration there is no workflow to wrap, so the request passes through
   * unchanged. */
  export function build(agentName: string, mode: string, query: string): string {
    const trimmed = query.trim() || "(empty request)"
    return WorkflowPromptRegistry.get(mode)?.projectUserMessage?.(trimmed, agentName) ?? trimmed
  }

  function messageMode(msg: MessageV2.WithParts): string | undefined {
    const md = msg.info.metadata as Record<string, any> | undefined
    const value = md?.[METADATA_MODE]
    if (typeof value === "string" && knownMode(value)) return value
    return undefined
  }

  function agentNameForMessage(message: MessageV2.WithParts, fallback: string): string {
    const value = (message.info.metadata as Record<string, any> | undefined)?.[METADATA_AGENT]
    if (typeof value === "string" && value.trim()) return value.trim()
    return fallback
  }
}
