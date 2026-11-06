import { Context } from "../util/context"
import { RuntimeContext } from "../lifecycle/context"
import { ObservabilitySchema } from "./schema"

export namespace ObservabilityContext {
  const storage = Context.create<ObservabilitySchema.Context>("observability")

  export function current(): ObservabilitySchema.Context {
    return storage.tryUse() ?? {}
  }

  export function merge(input: ObservabilitySchema.Context = {}): ObservabilitySchema.Context {
    const parent = current()
    return compact({
      ...parent,
      ...input,
      source: input.source ?? parent.source,
      module: input.module ?? parent.module,
      correlationId: input.correlationId ?? parent.correlationId,
      traceId: input.traceId ?? parent.traceId,
      parentSpanId: input.parentSpanId ?? parent.spanId ?? parent.parentSpanId,
    })
  }

  export function withContext<T>(context: ObservabilitySchema.Context, fn: () => T): T {
    return storage.provide(merge(context), fn)
  }

  export async function withContextAsync<T>(context: ObservabilitySchema.Context, fn: () => Promise<T>): Promise<T> {
    return storage.provide(merge(context), fn)
  }

  export function bind<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const context = current()
    const owner = RuntimeContext.tryCurrent()
    const bound = (...args: A) => storage.provide(context, () => fn(...args))
    return owner ? owner.bind(bound) : bound
  }

  export function child(input: ObservabilitySchema.Context = {}): ObservabilitySchema.Context {
    return merge(input)
  }

  export function compact<T extends Record<string, unknown>>(input: T): T {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) result[key] = value
    }
    return result as T
  }
}
