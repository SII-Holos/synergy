import { classifyNetworkError } from "./network-error"

export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
  retryDelay?: (error: unknown) => number | undefined
  signal?: AbortSignal
}

export function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      },
      Math.max(0, Math.min(ms, 2_147_483_647)),
    )
    signal?.addEventListener("abort", abort, { once: true })
  })
}

// Provenance: https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
// Local adaptation: accept finite retry-after-ms extensions and case-insensitive headers, rejecting partial numeric parses.
export function retryAfterMs(headers?: Headers | Record<string, string>, now = Date.now()): number | undefined {
  if (!headers) return undefined
  let values: Headers
  try {
    values = headers instanceof Headers ? headers : new Headers(headers)
  } catch {
    return undefined
  }
  const milliseconds = values.get("retry-after-ms")?.trim()
  if (milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds) && Number.isFinite(Number(milliseconds)))
    return Number(milliseconds)
  const value = values.get("retry-after")?.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) {
    const result = Number(value) * 1000
    return Number.isFinite(result) ? result : undefined
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))
    return undefined
  const result = Date.parse(value) - now
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

// Provenance: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
// Local adaptation: equal jitter keeps a positive half-delay while preserving server retry hints and caller cancellation.
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    delay = 500,
    factor = 2,
    maxDelay = 10000,
    retryIf = (error) => classifyNetworkError(error)?.kind === "transient",
    retryDelay,
    signal,
  } = options
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("Retry attempts must be a positive integer")
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await fn()
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt >= attempts - 1 || !retryIf(error)) throw error
      const hint = retryDelay?.(error)
      const wait =
        hint !== undefined && Number.isFinite(hint) && hint >= 0
          ? hint
          : Math.min(delay * Math.pow(factor, attempt), maxDelay) * (0.5 + Math.random() / 2)
      await retrySleep(wait, signal)
    }
  }
}
