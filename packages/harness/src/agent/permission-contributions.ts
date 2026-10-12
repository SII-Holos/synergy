import { RuntimeContext } from "../lifecycle/context"
import type { Agent } from "./agent"
import { PermissionNext } from "../permission/next"

export namespace AgentPermissionContributions {
  export type Contribution = (agent: Readonly<Agent.Info>) => PermissionNext.Ruleset | Promise<PermissionNext.Ruleset>
  const runtimeState = RuntimeContext.state(() => new Map<string, Contribution>())

  export function register(owner: string, contribution: Contribution) {
    const contributions = runtimeState()
    if (contributions.get(owner) === contribution) return
    RuntimeContext.assertCompositionOpen("agent permission contributions")
    if (contributions.has(owner)) throw new Error(`Duplicate Agent permission owner: ${owner}`)
    contributions.set(owner, contribution)
  }

  export async function apply(agent: Agent.Info) {
    for (const contribution of runtimeState().values()) {
      agent.permission = PermissionNext.merge(agent.permission, await contribution(agent))
    }
  }
}
