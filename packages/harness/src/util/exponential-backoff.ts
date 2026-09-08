export function exponentialBackoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1))
}

export function largestExponentialBackoffStepMs(baseMs: number, targetMs: number): number {
  return baseMs * 2 ** Math.floor(Math.log2(targetMs / baseMs))
}
