import type { ModelRole } from "../provider/model-role"

/**
 * S9d source inversion: the L1 agent registry reads plugin-contributed agent
 * entries through this registered source instead of importing the plugin
 * product domain. The L4 product manifest registers the concrete source.
 */
export namespace AgentPluginSource {
  export interface AgentEntry {
    name: string
    description: string
    prompt: string
    contributionId: string
    pluginId: string
    pluginGeneration: string
    mode?: "subagent" | "primary" | "all"
    model?: string
    modelRole?: ModelRole
    temperature?: number
    topP?: number
    steps?: number
    hidden?: boolean
    visibleTo?: string[]
    delegationGroups?: string[]
    color?: string
    permission?: Record<string, "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">>
  }

  export interface Source {
    agentEntries(): Promise<AgentEntry[]>
  }

  let source: Source | undefined

  export function register(value: Source): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
