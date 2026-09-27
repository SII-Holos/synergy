import { RuntimeContext } from "../lifecycle/context"
import { EnvironmentSchema } from "./schema"

export interface EnvironmentRequest {
  environmentID: string
  generation: number
  requestID: string
  spec: EnvironmentSchema.Info["spec"]
}

export interface EnvironmentProvider {
  readonly id: string
  readonly ownership?: "borrowed" | "managed"
  allocate(request: EnvironmentRequest): Promise<EnvironmentSchema.Allocation>
  inspect(
    request: EnvironmentRequest,
  ): Promise<{ state: "ready"; allocation: EnvironmentSchema.Allocation } | { state: "absent" } | { state: "unknown" }>
  deallocate(request: EnvironmentRequest): Promise<void>
}

export namespace EnvironmentProviders {
  const providers = RuntimeContext.state(() => new Map<string, EnvironmentProvider>())

  export function register(provider: EnvironmentProvider) {
    RuntimeContext.assertCompositionOpen("Environment providers")
    if (providers().has(provider.id)) throw new Error(`Duplicate Environment provider: ${provider.id}`)
    providers().set(provider.id, provider)
  }

  export function get(id: string): EnvironmentProvider {
    const provider = providers().get(id)
    if (!provider)
      throw new EnvironmentSchema.Unavailable({
        environmentID: "",
        message: `Environment provider is unavailable: ${id}`,
      })
    return provider
  }

  export function list() {
    return [...providers().values()].map(({ id, ownership }) => ({ id, ownership: ownership ?? "managed" }))
  }
}
