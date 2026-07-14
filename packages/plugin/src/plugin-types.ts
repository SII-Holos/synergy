export interface PluginSkill {
  name: string
  description: string
  content?: string
  references?: Record<string, string>
  dir?: string
}

export interface PluginAgent {
  name: string
  description: string
  prompt: string
  mode?: "subagent" | "primary" | "all"
  model?: string
  modelRole?: "vision" | "nano" | "mini" | "mid" | "thinking" | "long" | "creative"
  temperature?: number
  topP?: number
  steps?: number
  hidden?: boolean
  visibleTo?: string[]
  delegationGroups?: string[]
  color?: string
  permission?: Record<string, "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">>
}
