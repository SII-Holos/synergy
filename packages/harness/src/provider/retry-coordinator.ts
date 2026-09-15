import type { AgentTurnStream } from "../session/agent-turn/worker-pool"
import { retryAfterMs, retrySleep } from "@ericsanchezok/synergy-util/retry"
import { providerRetryable } from "./retry"

type Entry = {
  failures: number
  revision: number
  until: number
  probe?: symbol
  waiters: Set<() => void>
}

type Options = {
  now(): number
  random(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
  maxWaitMs: number
  maxEntries: number
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

// Provenance: https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
// Local adaptation: host-owned cooldown and one recovery probe before worker admission; caller retry budgets remain unchanged.
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
        if (!value.probe && !value.waiters.size && value.until <= now) this.entries.delete(key)
      }
      if (this.entries.size >= this.options.maxEntries) return
      entry = { failures: 0, revision: 0, until: now, waiters: new Set() }
      this.entries.set(key, entry)
    }
    entry.revision++
    entry.failures = Math.min(entry.failures + 1, 5)
    const headers = error && typeof error === "object" && "responseHeaders" in error ? error.responseHeaders : undefined
    const hint =
      headers && typeof headers === "object" ? retryAfterMs(headers as Record<string, string>, now) : undefined
    const delay = hint ?? Math.min(2_000 * 2 ** (entry.failures - 1), 30_000) * (0.5 + this.options.random() / 2)
    entry.until = Math.max(entry.until, now + Math.min(delay, 2_147_483_647))
    this.wake(entry)
  }

  async stream(key: string, signal: AbortSignal, start: () => Promise<AgentTurnStream>): Promise<AgentTurnStream> {
    const lease = await this.acquire(key, signal)
    let source: AgentTurnStream
    try {
      signal.throwIfAborted()
      this.closing.signal.throwIfAborted()
      source = await start()
    } catch (error) {
      lease.failure(error)
      lease.release()
      throw error
    }
    let completed = false
    let failed = false
    let disposal: Promise<void> | undefined
    function dispose() {
      disposal ??= (async () => {
        try {
          await source.dispose()
          if (completed && !failed) lease.success()
        } finally {
          lease.release()
        }
      })()
      return disposal
    }
    return {
      ...source,
      fullStream: (async function* () {
        try {
          for await (const part of source.fullStream) {
            if (part.type === "error") {
              failed = true
              lease.failure(part.error)
            }
            if (part.type === "abort") failed = true
            yield part
          }
          completed = true
        } catch (error) {
          failed = true
          lease.failure(error)
          throw error
        } finally {
          await dispose()
        }
      })(),
      dispose,
    }
  }

  async acquire(key: string, signal: AbortSignal) {
    const waiting = AbortSignal.any([signal, this.closing.signal])
    const deadline = this.options.now() + this.options.maxWaitMs
    let probe: { entry: Entry; token: symbol; revision: number } | undefined
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
      const delay = entry.until - this.options.now()
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
    return {
      failure: (error: unknown) => {
        if (released || failed || signal.aborted) return
        failed = true
        this.failure(key, error)
      },
      success: () => {
        if (released || failed || signal.aborted || !probe || this.entries.get(key) !== probe.entry) return
        if (probe.entry.probe !== probe.token || probe.entry.revision !== probe.revision) return
        this.entries.delete(key)
        this.wake(probe.entry)
      },
      release: () => {
        if (released) return
        released = true
        if (!probe || probe.entry.probe !== probe.token) return
        delete probe.entry.probe
        this.wake(probe.entry)
      },
    }
  }
}
