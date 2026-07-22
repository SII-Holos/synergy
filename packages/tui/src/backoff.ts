export type ReconnectBackoffOptions = {
  initialMs?: number
  maxMs?: number
  jitter?: number
  random?: () => number
}

export type ReconnectBackoff = {
  next(): number
  reset(): void
}

export function createReconnectBackoff(options: ReconnectBackoffOptions = {}): ReconnectBackoff {
  const initialMs = options.initialMs ?? 1_000
  const maxMs = options.maxMs ?? 30_000
  const jitter = options.jitter ?? 0.5
  const random = options.random ?? Math.random

  if (!Number.isFinite(initialMs) || initialMs <= 0) throw new Error("initial backoff must be positive")
  if (!Number.isFinite(maxMs) || maxMs < initialMs) throw new Error("maximum backoff must cover the initial delay")
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error("jitter must be between 0 and 1")

  let delay = initialMs
  return {
    next() {
      const unit = Math.min(1, Math.max(0, random()))
      const result = Math.round(delay * (1 - jitter + 2 * jitter * unit))
      delay = Math.min(delay * 2, maxMs)
      return result
    },
    reset() {
      delay = initialMs
    },
  }
}
