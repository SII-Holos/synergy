import { RuntimeContext } from "../lifecycle/context"
import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"

export namespace AgentBuiltins {
  type Factory = (context: BuiltinAgentContext) => Record<string, Agent.Info>
  const runtimeState = RuntimeContext.state(() => ({
    factories: new Map<string, Factory>(),
  }))

  export function register(owner: string, factory: Factory) {
    const instanceState = runtimeState()

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
