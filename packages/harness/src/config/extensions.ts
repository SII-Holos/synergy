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
  const contributions = new Map<string, Contribution>()
  const schemaResolvers = new WeakMap<object, () => z.ZodObject>()
  let generation = 0
  let complete = false
  let locked = false

  export function lock(): void {
    locked = true
  }

  export function assertRegistrationOpen(id: string): void {
    if (locked) throw new ConfigRegistrationLockedError(id)
  }

  export function isComplete() {
    return complete
  }

  export function completeRegistration() {
    if (complete) return
    assertRegistrationOpen("composition")
    complete = true
    generation++
  }

  export function register(id: string, contribution: Contribution): void {
    if (contributions.get(id) === contribution) return
    assertRegistrationOpen(id)
    for (const [otherID, other] of contributions) {
      if (otherID === id) continue
      for (const key of Object.keys(contribution.shape)) {
        if (key in other.shape) throw new Error(`Config field ${key} is already owned by ${otherID}`)
      }
    }
    contributions.set(id, contribution)
    generation++
  }

  export function schema<S extends z.ZodRawShape>(base: z.ZodObject<S>): z.ZodObject<S> {
    let seen = -1
    let current: z.ZodObject = base
    function resolved() {
      if (seen === generation) return current
      const shape = { ...base.shape }
      for (const contribution of contributions.values()) {
        for (const key of Object.keys(contribution.shape)) {
          if (key in base.shape) throw new Error(`Config field ${key} is already owned by the harness`)
        }
        Object.assign(shape, contribution.shape)
      }
      const composed = z.object(shape)
      current = (complete ? composed.strict() : composed.passthrough()).meta({ ref: "Config" })
      seen = generation
      return current
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
      for (const contribution of contributions.values()) {
        const schema = contribution.shape[key] as z.ZodType | undefined
        if (schema) return schema.optional().meta(schema.meta() ?? {})
      }
      return z.never().optional().describe(`Configuration field ${key} requires its owning capability`)
    }) as unknown as z.ZodOptional<Field<K>>
  }

  export function readField<K extends string>(config: Record<string, unknown>, key: K): z.output<Field<K>> | undefined {
    for (const contribution of contributions.values()) {
      if (contribution.shape[key]) return z.parse(contribution.shape[key], config[key]) as z.output<Field<K>>
    }
  }

  export function references(config: Record<string, unknown>, providerID: string): string[] {
    return [...contributions.values()].flatMap((contribution) => contribution.references?.(config, providerID) ?? [])
  }

  export function normalize(config: Record<string, unknown>) {
    for (const contribution of contributions.values()) contribution.normalize?.(config)
  }
  export function merge(
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
    result: Record<string, unknown>,
  ) {
    for (const contribution of contributions.values()) contribution.merge?.(current, patch, result)
  }
  export function resolve(config: Record<string, unknown>, filepath: string) {
    for (const contribution of contributions.values()) contribution.resolve?.(config, filepath)
  }
  export function redact(config: Record<string, unknown>, helpers: SecretHelpers) {
    for (const contribution of contributions.values()) contribution.redact?.(config, helpers)
  }
  export function restore(config: Record<string, unknown>, stored: Record<string, unknown>, helpers: SecretHelpers) {
    for (const contribution of contributions.values()) contribution.restore?.(config, stored, helpers)
  }
}
