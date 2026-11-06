import { RuntimeContext } from "../lifecycle/context"
import type { Agent } from "./agent"
import type { PrimaryAgentIdentity } from "./primary-identity"
import { PermissionNext } from "../permission/next"

export namespace AgentPermissionContributions {
  export interface Identity {
    registrationKey: string
    owner: string
    source: NonNullable<Agent.Info["source"]>
    primaryRole?: PrimaryAgentIdentity.Role
    subagentProfile?: string
  }
  export type Contribution = (
    agent: Readonly<Agent.Info>,
    identity: Readonly<Identity>,
  ) => PermissionNext.Ruleset | Promise<PermissionNext.Ruleset>
  export interface Phases {
    base?: Contribution
    final?: Contribution
  }
  const runtimeState = RuntimeContext.state(() => new Map<string, Contribution | Phases>())
  const identities = RuntimeContext.state(() => new WeakMap<Agent.Info, Readonly<Identity>>())

  export function identity(agent: Agent.Info) {
    return identities().get(agent)
  }

  export function register(owner: string, contribution: Contribution | Phases) {
    const contributions = runtimeState()
    if (contributions.get(owner) === contribution) return
    RuntimeContext.assertCompositionOpen("agent permission contributions")
    if (contributions.has(owner)) throw new Error(`Duplicate Agent permission owner: ${owner}`)
    contributions.set(owner, contribution)
  }

  export async function apply(agent: Agent.Info, identity: Identity, phase: keyof Phases = "final") {
    identities().set(agent, identity)
    for (const entry of runtimeState().values()) {
      const contribution = typeof entry === "function" ? (phase === "final" ? entry : undefined) : entry[phase]
      if (contribution) agent.permission = PermissionNext.merge(agent.permission, await contribution(agent, identity))
    }
  }
}
