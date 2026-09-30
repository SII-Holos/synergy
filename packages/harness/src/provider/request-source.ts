import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import type { MessageV2 } from "../session/message-v2"
import type { Provider } from "./provider"

export namespace ProviderRequestSource {
  export interface Input {
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    abort: AbortSignal
  }

  export interface Connection {
    key?: string
    headers?: Record<string, string>
    context?: Record<string, unknown>
  }

  export interface Source {
    prepare(input: Readonly<Input>): Promise<Connection>
  }

  export class PreparationError extends Error {
    constructor(cause: unknown) {
      super("Host provider request preparation failed", { cause })
      this.name = "ProviderRequestPreparationError"
    }
  }

  const connection = z.strictObject({
    key: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    context: z.record(z.string(), z.json()).optional(),
  })
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("provider request source")
    if (state().source) throw new Error("Provider request source is already registered")
    state().source = source
  }

  export async function prepare(input: Input, plan: Provider.WorkerPlan): Promise<Provider.WorkerPlan> {
    input.abort.throwIfAborted()
    const source = state().source
    if (!source) return plan
    try {
      const result = connection.parse(
        await source.prepare(
          Object.freeze({
            sessionID: input.sessionID,
            user: structuredClone(input.user),
            model: structuredClone(input.model),
            abort: input.abort,
          }),
        ),
      )
      input.abort.throwIfAborted()
      return {
        ...plan,
        ...(result.key !== undefined ? { key: result.key } : {}),
        options: {
          ...plan.options,
          ...(result.headers
            ? { headers: { ...(plan.options.headers as Record<string, string> | undefined), ...result.headers } }
            : {}),
          ...(result.context ? { hostRequest: result.context } : {}),
        },
      }
    } catch (error) {
      input.abort.throwIfAborted()
      throw new PreparationError(error)
    }
  }
}
