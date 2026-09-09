/**
 * S9d link target port: the L1 remote-execution state machine resolves
 * persisted Synergy Link targets and enforces agent access through this
 * registered source instead of importing the synergy-link product domain.
 * The L4 product manifest registers the concrete store.
 */
export namespace ToolLinkTargetSource {
  export interface TargetInfo {
    id: string
    linkID: string
    targetAgentID: string
    enabled: boolean
    allowedAgents: string[]
  }

  export interface Source {
    requireTarget(id: string): Promise<TargetInfo>
    findRegisteredTarget(linkID: string, targetAgentID?: string): Promise<TargetInfo | undefined>
    assertAgentAccess(target: TargetInfo, agent: string): void
  }

  let source: Source | undefined

  export function register(value: Source | undefined): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
