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

  export function collect(context: BuiltinAgentContext) {
    const instanceState = runtimeState()

    const result: Record<string, Agent.Info> = {}
    for (const factory of instanceState.factories.values()) {
      for (const [name, agent] of Object.entries(factory(context))) {
        if (name in result) throw new Error(`Duplicate contributed agent: ${name}`)
        result[name] = agent
      }
    }
    return result
  }
}
