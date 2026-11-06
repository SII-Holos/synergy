import { RuntimeContext } from "../lifecycle/context"
import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"
import { z } from "zod"

export namespace AgentBuiltins {
  export const Family = z.enum(["primary", "legacy", "max", "internal"])
  export type Family = z.infer<typeof Family>
  type Factory = (context: BuiltinAgentContext) => Record<string, Agent.Info>
  const runtimeState = RuntimeContext.state(() => ({
    factories: new Map<string, Factory>(),
    owners: new WeakMap<Agent.Info, string>(),
    profiles: new WeakMap<Agent.Info, string>(),
    prompts: new Map<string, { owner: string; build: (agents: readonly Agent.Info[]) => string }>(),
    families: undefined as Set<Family> | undefined,
  }))

  export function selectDefaultFamilies(families: readonly Family[]) {
    RuntimeContext.assertCompositionOpen("default agent families")
    const state = runtimeState()
    if (state.families) throw new Error("Default agent families are already selected")
    state.families = new Set(Family.array().parse(families))
  }

  export function enabled(family: Family) {
    return runtimeState().families?.has(family) ?? true
  }

  export function register(owner: string, factory: Factory) {
    const instanceState = runtimeState()
    if (instanceState.factories.get(owner) === factory) return
    RuntimeContext.assertCompositionOpen("builtin agents")
    if (instanceState.factories.has(owner)) throw new Error(`Duplicate builtin agent owner: ${owner}`)
    instanceState.factories.set(owner, factory)
  }

  export function tagProfile(agent: Agent.Info, profile: string) {
    runtimeState().profiles.set(agent, profile)
  }

  export function profile(agent: Agent.Info) {
    return runtimeState().profiles.get(agent)
  }

  export function owner(agent: Agent.Info) {
    return runtimeState().owners.get(agent)
  }

  export function registerPrompt(owner: string, key: string, build: (agents: readonly Agent.Info[]) => string) {
    const prompts = runtimeState().prompts
    if (prompts.get(key)?.build === build) return
    RuntimeContext.assertCompositionOpen("agent prompt builders")
    if (prompts.has(key)) throw new Error(`Duplicate agent prompt: ${key}`)
    prompts.set(key, { owner, build })
  }

  export function buildPrompts(agents: Record<string, Agent.Info>, overrides: ReadonlySet<string>) {
    for (const [key, contribution] of runtimeState().prompts) {
      const agent = agents[key]
      if (agent && owner(agent) === contribution.owner && !overrides.has(key))
        agent.prompt = contribution.build(Object.values(agents))
    }
  }

  export function collect(context: BuiltinAgentContext) {
    const instanceState = runtimeState()

    const result: Record<string, Agent.Info> = {}
    for (const [owner, factory] of instanceState.factories) {
      for (const [name, agent] of Object.entries(factory(context))) {
        if (name in result) throw new Error(`Duplicate contributed agent: ${name}`)
        instanceState.owners.set(agent, owner)
        result[name] = agent
      }
    }
    return result
  }
}
