import type { AgentTurnStream, AgentTurnStreamPart } from "../session/agent-turn/worker-pool"
import { retryAfterMs, retrySleep } from "@ericsanchezok/synergy-util/retry"
import { providerRetryable } from "./retry"

type Entry = {
  failures: number
  revision: number
  until: number
  retryAfter: number
  admitAfter: number
  error: unknown
  probe?: symbol
  waiters: Set<() => void>
}

export type ProviderRecoveryWait = { error: unknown; next?: number; retry?: () => boolean }
export type ProviderRecoveryOptions = {
  immediate?: boolean
  onWait?: (state: ProviderRecoveryWait | undefined) => void
}

type Options = {
  now(): number
  random(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
  maxWaitMs: number
  maxEntries: number
  recoveryIntervalMs: number
}

function providerProgress(part: AgentTurnStreamPart) {
  switch (part.type) {
    case "text-delta":
    case "reasoning-delta":
      return part.text.length > 0
    case "tool-input-delta":
      return part.delta.length > 0
    case "tool-call":
      return true
    default:
      return false
  }
}

export function providerRetryKey(
  model: {
    providerID: string
    id?: string
    api?: { url?: string }
    options?: Record<string, unknown>
    headers?: Record<string, string>
  },
  provider?: { key?: string; options: Record<string, unknown> },
) {
  const options = { ...provider?.options, ...model.options }
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        model.providerID,
        options.baseURL ?? model.api?.url,
        options.apiKey ?? provider?.key,
        options.headers,
        model.headers && Object.entries(model.headers).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex")
}

// Reports only the host so persisted diagnostics never carry endpoint paths or query credentials.
export function providerEndpointHost(
  model: { api?: { url?: string }; options?: Record<string, unknown> },
  provider?: { options: Record<string, unknown> },
) {
  const options = { ...provider?.options, ...model.options }
  const endpoint = options.baseURL ?? model.api?.url
  if (typeof endpoint !== "string") return undefined
  try {
    return new URL(endpoint).host || undefined
  } catch {
    return undefined
  }
}

// Provenance: https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
// Provenance: https://platform.claude.com/docs/en/api/errors
// Local adaptation: meaningful stream progress permits paced probes before completion; midstream failures retain shared cooldown.
export class ProviderRetryCoordinator {
  private readonly entries = new Map<string, Entry>()
  private readonly closing = new AbortController()
  private readonly options: Options

  constructor(options: Partial<Options> = {}) {
    this.options = {
      now: Date.now,
      random: Math.random,
      sleep: retrySleep,
      maxWaitMs: 5 * 60_000,
      maxEntries: 1024,
      recoveryIntervalMs: 1_000,
      ...options,
    }
  }

  close() {
    this.closing.abort(new Error("Provider request admission is closed"))
  }

  private wake(entry: Entry) {
    for (const notify of entry.waiters) notify()
  }

  private failure(key: string, error: unknown) {
    if (providerRetryable(error) !== true) return
    const now = this.options.now()
    let entry = this.entries.get(key)
    if (!entry) {
      for (const [key, value] of this.entries) {
        if (!value.probe && !value.waiters.size && Math.max(value.until, value.admitAfter) <= now)
          this.entries.delete(key)
      }
      if (this.entries.size >= this.options.maxEntries) return
      entry = { failures: 0, revision: 0, until: now, retryAfter: 0, admitAfter: 0, error, waiters: new Set() }
      this.entries.set(key, entry)
    }
    entry.revision++
    entry.error = error
    entry.failures = Math.min(entry.failures + 1, 5)
    const headers = error && typeof error === "object" && "responseHeaders" in error ? error.responseHeaders : undefined
    const hint =
      headers && typeof headers === "object" ? retryAfterMs(headers as Record<string, string>, now) : undefined
    const delay = hint ?? Math.min(2_000 * 2 ** (entry.failures - 1), 30_000) * (0.5 + this.options.random() / 2)
    entry.until = Math.max(entry.until, now + Math.min(delay, 2_147_483_647))
    if (hint !== undefined) entry.retryAfter = Math.max(entry.retryAfter, now + Math.min(hint, 2_147_483_647))
    this.wake(entry)
  }

  async acquire(key: string, signal: AbortSignal, recovery?: ProviderRecoveryOptions) {
    const waiting = AbortSignal.any([signal, this.closing.signal])
    const deadline = this.options.now() + this.options.maxWaitMs
    let probe: { entry: Entry; token: symbol; revision: number } | undefined
    const expedite = (entry: Entry) => {
      if (
        waiting.aborted ||
        this.entries.get(key) !== entry ||
        entry.probe ||
        entry.until <= this.options.now() ||
        entry.admitAfter > this.options.now() ||
        entry.retryAfter > this.options.now()
      )
        return false
      entry.until = this.options.now()
      this.wake(entry)
      return true
    }
    const initial = this.entries.get(key)
    if (initial && recovery?.immediate) expedite(initial)
    while (true) {
      waiting.throwIfAborted()
      const entry = this.entries.get(key)
      if (!entry) break
      const remaining = deadline - this.options.now()
      if (remaining <= 0) {
        const error = new Error("Provider recovery did not complete within the waiting limit. Try again later.")
        error.name = "ProviderRecoveryTimeoutError"
        throw error
      }
      const next = Math.max(entry.until, entry.admitAfter)
      const delay = next - this.options.now()
      if (!entry.probe && delay <= 0) {
        const token = Symbol()
        entry.probe = token
        probe = { entry, token, revision: entry.revision }
        break
      }
      const changed = new AbortController()
      const notify = () => changed.abort()
      entry.waiters.add(notify)
      try {
        recovery?.onWait?.({
          error: entry.error,
          next: entry.probe ? undefined : next,
          retry:
            !entry.probe && entry.retryAfter <= this.options.now() && entry.admitAfter <= this.options.now()
              ? () => expedite(entry)
              : undefined,
        })
        await this.options.sleep(
          Math.min(remaining, delay > 0 ? delay : remaining),
          AbortSignal.any([waiting, changed.signal]),
        )
      } catch (error) {
        waiting.throwIfAborted()
        if (!changed.signal.aborted) throw error
      } finally {
        entry.waiters.delete(notify)
      }
    }
    let released = false
    let failed = false
    let progressed = false
    const releaseProbe = () => {
      if (!probe || probe.entry.probe !== probe.token) return
      delete probe.entry.probe
      this.wake(probe.entry)
    }
    const release = () => {
      if (released) return
      released = true
      waiting.removeEventListener("abort", release)
      releaseProbe()
    }
    const lease = {
      failure: (error: unknown) => {
        if (released || failed || waiting.aborted) return
        failed = true
        this.failure(key, error)
        releaseProbe()
      },
      progress: () => {
        if (released || failed || progressed || waiting.aborted || !probe || this.entries.get(key) !== probe.entry)
          return
        progressed = true
        probe.entry.admitAfter = Math.max(probe.entry.admitAfter, this.options.now() + this.options.recoveryIntervalMs)
        releaseProbe()
      },
      success: () => {
        if (released || failed || waiting.aborted || !probe || this.entries.get(key) !== probe.entry) return
        if (probe.entry.revision !== probe.revision) return
        this.entries.delete(key)
        this.wake(probe.entry)
      },
      release,
      async stream(start: () => Promise<AgentTurnStream>): Promise<AgentTurnStream> {
        let source: AgentTurnStream
        try {
          waiting.throwIfAborted()
          source = await start()
        } catch (error) {
          lease.failure(error)
          release()
          throw error
        }
        let streamFailed = false
        let disposal: Promise<void> | undefined
        function dispose() {
          disposal ??= (async () => {
            release()
            await source.dispose()
          })()
          return disposal
        }
        return {
          ...source,
          fullStream: (async function* () {
            try {
              for await (const part of source.fullStream) {
                if (part.type === "error") {
                  streamFailed = true
                  lease.failure(part.error)
                }
                if (part.type === "abort") {
                  streamFailed = true
                  release()
                }
                if (providerProgress(part)) lease.progress()
                yield part
              }
              if (!streamFailed) lease.success()
            } catch (error) {
              lease.failure(error)
              throw error
            } finally {
              await dispose()
            }
          })(),
          dispose,
        }
      },
    }
    waiting.addEventListener("abort", release, { once: true })
    try {
      recovery?.onWait?.(undefined)
      waiting.throwIfAborted()
      return lease
    } catch (error) {
      release()
      throw error
    }
  }
}
