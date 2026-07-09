export interface AgentInfo {
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
  visibleTo?: string[]
  delegationGroups?: string[]
}
