export const HOST_OWNED_MESSAGE_TYPES = ["attachment", "tool", "text", "reasoning", "compaction_recovery"] as const
export type HostOwnedMessageType = (typeof HOST_OWNED_MESSAGE_TYPES)[number]

export interface PluginSkill {
  name: string
  description: string
  content?: string
  references?: Record<string, string>
  dir?: string
}

export const PLUGIN_MODEL_ROLES = ["vision", "nano", "mini", "mid", "thinking", "long", "creative"] as const
export type PluginModelRole = (typeof PLUGIN_MODEL_ROLES)[number]

export interface PluginAgent {
  /** Public registry name used by Agent.get(), delegation, and Agent Host Services. */
  name: string
  description: string
  prompt: string
  mode?: "subagent" | "primary" | "all"
  model?: string
  modelRole?: PluginModelRole
  temperature?: number
  topP?: number
  steps?: number
  hidden?: boolean
  visibleTo?: string[]
  delegationGroups?: string[]
  color?: string
  permission?: Record<string, "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">>
}
