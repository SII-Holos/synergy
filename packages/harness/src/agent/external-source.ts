import { RuntimeContext } from "../lifecycle/context"
import z from "zod"

/**
 * S9d source inversion: the external-agent descriptor embedded in Agent.Info
 * and the adapter discovery entry points are reached through this L1 module
 * instead of the agent domain importing the external-agent product domain.
 * The schema instance is re-exported by the external-agent bridge so the
 * generated SDK keeps a single `ExternalAgentInfo` definition.
 */
export namespace AgentExternal {
  export const Info = z
    .object({
      adapter: z.string(),
      path: z.string().optional(),
      version: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "ExternalAgentInfo" })
  export type Info = z.infer<typeof Info>
}

export namespace AgentExternalSource {
  export interface Source {
    loadAdapters(): Promise<void>
    description(name: string): string | undefined
    discover(): Promise<Map<string, AgentExternal.Info>>
  }

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source): void {
    const instanceState = runtimeState()

    if (instanceState.source === value) return
    RuntimeContext.assertCompositionOpen("agent/external-source")
    if (instanceState.source && value) throw new Error("agent/external-source is already registered")
    instanceState.source = value
  }

  export function get(): Source | undefined {
    const instanceState = runtimeState()

    return instanceState.source
  }
}
