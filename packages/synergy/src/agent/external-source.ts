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
    discover(config?: Record<string, Record<string, unknown> | undefined>): Promise<Map<string, AgentExternal.Info>>
  }

  let source: Source | undefined

  export function register(value: Source): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
