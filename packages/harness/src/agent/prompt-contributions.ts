import { RuntimeContext } from "../lifecycle/context"
import type { Agent } from "./agent"
import { AgentPermissionContributions } from "./permission-contributions"

export namespace AgentPromptContributions {
  export interface Contribution {
    requiredTools: readonly string[]
    render(agent: Readonly<Agent.Info>, identity: Readonly<AgentPermissionContributions.Identity> | undefined): string
  }
  const state = RuntimeContext.state(() => new Map<string, readonly Contribution[]>())

  export function register(owner: string, contributions: readonly Contribution[]) {
    if (state().get(owner) === contributions) return
    RuntimeContext.assertCompositionOpen("agent prompt contributions")
    if (state().has(owner)) throw new Error(`Duplicate agent prompt owner: ${owner}`)
    state().set(owner, contributions)
  }

  export function render(agent: Agent.Info, availableTools: ReadonlySet<string>): string[] {
    return [...state().values()].flatMap((contributions) =>
      contributions.flatMap((contribution) =>
        contribution.requiredTools.every((tool) => availableTools.has(tool))
          ? [contribution.render(agent, AgentPermissionContributions.identity(agent))].filter(Boolean)
          : [],
      ),
    )
  }
}
