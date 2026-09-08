import type { MessageV2 } from "./message-v2"
import { Log } from "../util/log"

export namespace SessionContextContributions {
  export const DEFAULT_TIMEOUT_MS = 15_000
  export interface Input {
    sessionID: string
    scopeID: string
    messages: MessageV2.WithParts[]
    isTopSession: boolean
    signal: AbortSignal
  }
  export interface Result {
    context: string
    injection: Record<string, string>
  }
  export interface Collected extends Result {
    sources: Array<{ id: string; injection: Record<string, string> }>
  }
  export interface Provider {
    enabled?(input: Input): boolean | Promise<boolean>
    contribute(input: Input): Promise<Result | undefined>
    fallback?(input: Input): Result | undefined | Promise<Result | undefined>
    committed?(sessionID: string, injection: Record<string, string>): void
    onAssistantComplete?(message: MessageV2.Assistant): void
    timeoutMs?: number
  }
  const providers = new Map<string, Provider>()
  const log = Log.create({ service: "session.context-contributions" })

  export function register(id: string, provider: Provider): () => void {
    providers.set(id, provider)
    return () => {
      if (providers.get(id) === provider) providers.delete(id)
    }
  }

  export async function collect(input: Input): Promise<Collected | undefined> {
    input.signal.throwIfAborted()
    const results = await Promise.all(
      [...providers].map(async ([id, provider]) => {
        if (provider.enabled && !(await provider.enabled(input))) return
        input.signal.throwIfAborted()
        const timeout = new AbortController()
        const signal = AbortSignal.any([input.signal, timeout.signal])
        const timer = setTimeout(
          () => timeout.abort(new Error("Context contribution timed out")),
          provider.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        const scoped = { ...input, signal }
        try {
          const result = await abortable(provider.contribute(scoped), signal)
          return { id, result: result ?? (await fallback(provider, input)) }
        } catch (error) {
          input.signal.throwIfAborted()
          log.warn("context contribution failed", { id, error })
          return { id, result: await fallback(provider, input) }
        } finally {
          clearTimeout(timer)
        }
      }),
    )
    input.signal.throwIfAborted()
    const active = results.flatMap((entry) => (entry?.result ? [{ id: entry.id, result: entry.result }] : []))
    if (!active.length) return
    return {
      context: active.map(({ result }) => result.context).join("\n\n"),
      injection: Object.assign({}, ...active.map(({ result }) => result.injection)),
      sources: active.map(({ id, result }) => ({ id, injection: result.injection })),
    }
  }

  export function committed(sessionID: string, result: Collected): void {
    for (const source of result.sources) providers.get(source.id)?.committed?.(sessionID, source.injection)
  }

  export function onAssistantComplete(message: MessageV2.Assistant): void {
    for (const provider of providers.values()) provider.onAssistantComplete?.(message)
  }

  async function fallback(provider: Provider, input: Input): Promise<Result | undefined> {
    if (!provider.fallback) return
    try {
      return await abortable(Promise.resolve(provider.fallback(input)), input.signal)
    } catch (error) {
      input.signal.throwIfAborted()
      log.warn("context fallback failed", { error })
    }
  }

  async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
    })
    try {
      return await Promise.race([promise, cancelled])
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }
}
