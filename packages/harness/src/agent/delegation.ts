export interface DelegationCaller {
  name: string
  delegationGroups?: string[]
}

export interface DelegatableAgent {
  name: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
  visibleTo?: string[]
}

export namespace AgentDelegation {
  export function identities(caller?: DelegationCaller | string): string[] {
    if (!caller) return []
    if (typeof caller === "string") return [caller]
    return Array.from(new Set([caller.name, ...(caller.delegationGroups ?? [])]))
  }

  export function isVisibleToCaller(agent: Pick<DelegatableAgent, "visibleTo">, caller?: DelegationCaller | string) {
    if (!agent.visibleTo || agent.visibleTo.length === 0) return true
    const callerIdentities = identities(caller)
    if (callerIdentities.length === 0) return false
    return agent.visibleTo.some((name) => callerIdentities.includes(name))
  }

  export function canDelegateTo(agent: DelegatableAgent, caller?: DelegationCaller | string) {
    if (agent.mode === "primary") return false
    if (agent.hidden) return false
    const callerIdentities = identities(caller)
    if (callerIdentities.includes(agent.name)) return false
    return isVisibleToCaller(agent, caller)
  }

  /**
   * Host-owned workflows may invoke private subagents without exposing them to
   * the model. The host must establish its own authorization before using this
   * predicate; this function only preserves the universal subagent boundaries.
   */
  export function canProgrammaticallyDelegateTo(agent: DelegatableAgent, caller?: DelegationCaller | string) {
    if (agent.mode === "primary") return false
    return !identities(caller).includes(agent.name)
  }
}
