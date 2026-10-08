import { RuntimeContext } from "../lifecycle/context"
import { z } from "zod"
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
    fields: new Map<string, { generation: number; schema: z.ZodType }>(),
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

  type JSONSchemaParams = NonNullable<Parameters<typeof z.toJSONSchema>[1]>
  interface JSONSchemaContext {
    seen: Map<z.core.$ZodType, { ref?: z.core.$ZodType | null }>
  }
  interface JSONSchemaPath {
    path: (string | number)[]
    schemaPath: z.core.$ZodType[]
  }
  interface JSONSchemaTraversal {
    process(schema: z.core.$ZodType, context: JSONSchemaContext, params: JSONSchemaPath): unknown
    createToJSONSchemaMethod(schema: z.core.$ZodType): (params?: JSONSchemaParams) => unknown
    createStandardJSONSchemaMethod(schema: z.core.$ZodType, io: "input" | "output"): (params: unknown) => unknown
  }

  // Provenance: https://github.com/colinhacks/zod/blob/f3c9ec03ba7a28ae72d25cc295f38674bee0f559/packages/zod/src/v4/core/to-json-schema.ts
  // Local adaptation: use native wrapper refs for distinct facade/instance identities; processJSONSchema is internal and version-coupled.
  export function dynamicSchema<T extends z.ZodType>(resolved: () => T): T {
    const views = new WeakMap<T, T["_zod"]>()
    const traversal = z.core as unknown as Partial<JSONSchemaTraversal>
    const process = traversal.process
    function internals(schema: T): T["_zod"] {
      const original = schema._zod
      if (!Reflect.get(original, "processJSONSchema")) return original
      if (!process) throw new Error("Dynamic schema requires the native Zod JSON Schema traversal")
      const cached = views.get(schema)
      if (cached) return cached
      const processor = (context: JSONSchemaContext, _json: unknown, params: JSONSchemaPath) => {
        process(schema, context, params)
        const entry = context.seen.get(proxy)
        if (!entry) throw new Error("Dynamic schema is missing from the native JSON Schema traversal")
        entry.ref = schema
      }
      const view = new Proxy(original, {
        get(target, property) {
          return property === "processJSONSchema" ? processor : Reflect.get(target, property)
        },
      })
      views.set(schema, view)
      return view
    }
    let toJSONSchema: ((params?: JSONSchemaParams) => unknown) | undefined
    let standardJSONSchema: { input(params: unknown): unknown; output(params: unknown): unknown } | undefined
    function value(schema: T, property: string | symbol): unknown {
      if (property === "_zod") return internals(schema)
      if (property === "toJSONSchema" && traversal.createToJSONSchemaMethod) {
        return (toJSONSchema ??= traversal.createToJSONSchemaMethod(proxy))
      }
      const result = Reflect.get(schema, property)
      if (property === "~standard" && traversal.createStandardJSONSchemaMethod) {
        standardJSONSchema ??= {
          input: traversal.createStandardJSONSchemaMethod(proxy, "input"),
          output: traversal.createStandardJSONSchemaMethod(proxy, "output"),
        }
        return { ...result, jsonSchema: standardJSONSchema }
      }
      return typeof result === "function" ? result.bind(schema) : result
    }
    const proxy: T = new Proxy({} as T, {
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
        const schema = resolved()
        const descriptor = Reflect.getOwnPropertyDescriptor(schema, property)
        if (!descriptor) return
        if (property === "_zod" || property === "toJSONSchema" || property === "~standard") {
          return { configurable: true, enumerable: descriptor.enumerable, value: value(schema, property) }
        }
        return { ...descriptor, configurable: true }
      },
      get(_target, property) {
        return value(resolved(), property)
      },
    })
    return proxy
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
      const instance = state()
      const cached = instance.fields.get(key)
      if (cached?.generation === instance.generation) return cached.schema
      const owner = [...instance.contributions.values()].find((contribution) => contribution.shape[key])?.shape[key] as
        | z.ZodType
        | undefined
      const metadata = { ...owner?.meta() }
      delete metadata.id
      const schema = owner
        ? owner.optional().meta(metadata)
        : z.never().optional().describe(`Configuration field ${key} requires its owning capability`)
      instance.fields.set(key, { generation: instance.generation, schema })
      return schema
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
