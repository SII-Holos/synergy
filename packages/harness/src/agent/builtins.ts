import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"

export namespace AgentBuiltins {
  type Factory = (context: BuiltinAgentContext) => Record<string, Agent.Info>
  const factories = new Map<string, Factory>()

  export function register(owner: string, factory: Factory) {
    factories.set(owner, factory)
  }

  export function collect(context: BuiltinAgentContext) {
    const result: Record<string, Agent.Info> = {}
    for (const factory of factories.values()) {
      for (const [name, agent] of Object.entries(factory(context))) {
        if (name in result) throw new Error(`Duplicate contributed agent: ${name}`)
        result[name] = agent
      }
    }
    return result
  }
}
