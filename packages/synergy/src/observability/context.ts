import { AsyncLocalStorage } from "node:async_hooks"
import { ObservabilitySchema } from "./schema"

export namespace ObservabilityContext {
  const storage = new AsyncLocalStorage<ObservabilitySchema.Context>()

  export function current(): ObservabilitySchema.Context {
    return storage.getStore() ?? {}
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
    return storage.run(merge(context), fn)
  }

  export async function withContextAsync<T>(context: ObservabilitySchema.Context, fn: () => Promise<T>): Promise<T> {
    return storage.run(merge(context), fn)
  }

  export function bind<T extends (...args: any[]) => any>(fn: T): T {
    const context = current()
    return ((...args: Parameters<T>) => storage.run(context, () => fn(...args))) as T
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
