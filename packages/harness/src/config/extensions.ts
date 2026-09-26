import { RuntimeContext } from "../lifecycle/context"
import z from "zod"
import type { ConfigExtensionShape } from "./schema"

export class ConfigRegistrationLockedError extends Error {
  constructor(readonly domain: string) {
    super(`Register config domain ${domain} before opening the runtime`)
    this.name = "ConfigRegistrationLockedError"
  }
}

export namespace ConfigExtensions {
  export interface SecretHelpers {
    sentinel: string
    redact(record: Record<string, unknown>): void
    restore(incoming: Record<string, unknown>, stored: Record<string, unknown> | undefined): void
  }
  export interface Contribution {
    shape: z.ZodRawShape
    references?(config: Record<string, unknown>, providerID: string): string[]
    normalize?(config: Record<string, unknown>): void
    merge?(current: Record<string, unknown>, patch: Record<string, unknown>, result: Record<string, unknown>): void
    resolve?(config: Record<string, unknown>, filepath: string): void
    redact?(config: Record<string, unknown>, helpers: SecretHelpers): void
    restore?(config: Record<string, unknown>, stored: Record<string, unknown>, helpers: SecretHelpers): void
  }
  const state = RuntimeContext.state(() => ({
    contributions: new Map<string, Contribution>(),
    generation: 0,
    complete: false,
    locked: false,
    schemas: new WeakMap<object, { generation: number; schema: z.ZodObject }>(),
  }))
  const schemaResolvers = new WeakMap<object, () => z.ZodObject>()

  export function lock(): void {
    state().locked = true
  }

  export function assertRegistrationOpen(id: string): void {
    if (state().locked) throw new ConfigRegistrationLockedError(id)
  }

  export function isComplete() {
    return state().complete
  }

  export function completeRegistration() {
    if (state().complete) return
    assertRegistrationOpen("composition")
    state().complete = true
    state().generation++
  }

  export function register(id: string, contribution: Contribution): void {
    const existing = state().contributions.get(id)
    if (existing === contribution) return
    if (existing) throw new Error(`Config domain ${id} is already registered`)
    assertRegistrationOpen(id)
    for (const [otherID, other] of state().contributions) {
      if (otherID === id) continue
      for (const key of Object.keys(contribution.shape)) {
        if (key in other.shape) throw new Error(`Config field ${key} is already owned by ${otherID}`)
      }
    }
    state().contributions.set(id, contribution)
    state().generation++
  }

  export function schema<S extends z.ZodRawShape>(base: z.ZodObject<S>): z.ZodObject<S> {
    function resolved() {
      const instance = state()
      const cached = instance.schemas.get(base)
      if (cached?.generation === instance.generation) return cached.schema
      const shape = { ...base.shape }
      for (const contribution of state().contributions.values()) {
        for (const key of Object.keys(contribution.shape)) {
          if (key in base.shape) throw new Error(`Config field ${key} is already owned by the harness`)
        }
        Object.assign(shape, contribution.shape)
      }
      const composed = z.object(shape)
      const schema = (instance.complete ? composed.strict() : composed.passthrough()).meta({ ref: "Config" })
      instance.schemas.set(base, { generation: instance.generation, schema })
      return schema
    }
    const proxy = dynamicSchema(resolved) as z.ZodObject<S>
    z.globalRegistry.add(proxy, { ref: "Config" })
    schemaResolvers.set(proxy, resolved)
    return proxy
  }

  export function dynamicSchema<T extends z.ZodType>(resolved: () => T): T {
    return new Proxy({} as T, {
      getPrototypeOf() {
        return Reflect.getPrototypeOf(resolved())
      },
      has(_target, property) {
        return Reflect.has(resolved(), property)
      },
      ownKeys() {
        return Reflect.ownKeys(resolved())
      },
      getOwnPropertyDescriptor(_target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(resolved(), property)
        return descriptor ? { ...descriptor, configurable: true } : undefined
      },
      get(_target, property) {
        const value = Reflect.get(resolved(), property)
        return typeof value === "function" ? value.bind(resolved()) : value
      },
    })
  }

  export function resolveSchema<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<S> {
    return (schemaResolvers.get(schema)?.() ?? schema) as z.ZodObject<S>
  }

  type Field<K extends string> = K extends keyof ConfigExtensionShape
    ? ConfigExtensionShape[K] extends z.ZodType
      ? ConfigExtensionShape[K]
      : z.ZodUnknown
    : z.ZodUnknown

  export function field<K extends string>(key: K): z.ZodOptional<Field<K>> {
    return dynamicSchema(() => {
      for (const contribution of state().contributions.values()) {
        const schema = contribution.shape[key] as z.ZodType | undefined
        if (schema) return schema.optional().meta(schema.meta() ?? {})
      }
      return z.never().optional().describe(`Configuration field ${key} requires its owning capability`)
    }) as unknown as z.ZodOptional<Field<K>>
  }

  export function readField<K extends string>(config: Record<string, unknown>, key: K): z.output<Field<K>> | undefined {
    for (const contribution of state().contributions.values()) {
      if (contribution.shape[key]) return z.parse(contribution.shape[key], config[key]) as z.output<Field<K>>
    }
  }

  export function references(config: Record<string, unknown>, providerID: string): string[] {
    return [...state().contributions.values()].flatMap(
      (contribution) => contribution.references?.(config, providerID) ?? [],
    )
  }

  export function normalize(config: Record<string, unknown>) {
    for (const contribution of state().contributions.values()) contribution.normalize?.(config)
  }
  export function merge(
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
    result: Record<string, unknown>,
  ) {
    for (const contribution of state().contributions.values()) contribution.merge?.(current, patch, result)
  }
  export function resolve(config: Record<string, unknown>, filepath: string) {
    for (const contribution of state().contributions.values()) contribution.resolve?.(config, filepath)
  }
  export function redact(config: Record<string, unknown>, helpers: SecretHelpers) {
    for (const contribution of state().contributions.values()) contribution.redact?.(config, helpers)
  }
  export function restore(config: Record<string, unknown>, stored: Record<string, unknown>, helpers: SecretHelpers) {
    for (const contribution of state().contributions.values()) contribution.restore?.(config, stored, helpers)
  }
}
