import { RuntimeContext } from "../lifecycle/context"
import { EnvironmentSchema } from "./schema"
import type { Executor } from "./executor"

export interface EnvironmentRequest {
  environmentID: string
  generation: number
  requestID: string
  spec: EnvironmentSchema.Info["spec"]
}

export interface EnvironmentProvider {
  readonly id: string
  readonly ownership?: "borrowed" | "managed"
  validateSpec?(spec: EnvironmentSchema.Info["spec"]): EnvironmentSchema.Info["spec"]
  allocate(request: EnvironmentRequest): Promise<EnvironmentSchema.Allocation>
  inspect(
    request: EnvironmentRequest,
  ): Promise<
    | { state: "ready"; allocation: EnvironmentSchema.Allocation }
    | { state: "absent" }
    | { state: "unknown" }
    | { state: "pending" }
  >
  resume?(request: EnvironmentRequest): Promise<EnvironmentSchema.Allocation>
  deallocate(request: EnvironmentRequest): Promise<void>
  connect?(request: EnvironmentRequest, target: EnvironmentSchema.Target): Promise<Executor>
  close?(): Promise<void>
}

export namespace EnvironmentProviders {
  const providers = RuntimeContext.state(() => new Map<string, EnvironmentProvider>())
  const defaults = RuntimeContext.state(() => ({ selection: undefined as Default | undefined }))
  export interface Default {
    provider: string
    spec: EnvironmentSchema.Info["spec"]
    idleTimeoutMs?: number
  }

  export function setDefault(selection: Default) {
    RuntimeContext.assertCompositionOpen("Default Environment")
    if (defaults().selection) throw new Error("Default Environment is already registered")
    const provider = get(selection.provider)
    defaults().selection = structuredClone({
      ...selection,
      spec: provider.validateSpec?.(selection.spec) ?? selection.spec,
    })
  }

  export function defaultSelection(): Default | undefined {
    return structuredClone(defaults().selection)
  }

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

  export async function close() {
    const results = await Promise.allSettled([...providers().values()].map((provider) => provider.close?.()))
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Environment provider shutdown failed")
  }
}
