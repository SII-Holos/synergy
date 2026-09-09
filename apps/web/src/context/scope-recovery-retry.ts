// Bounded retry scheduling for failed web sync recovery (reconnect replay or
// full resync). A silently failed recovery leaves the viewed session stale
// until a manual reload, so failures are retried per scope with exponential
// backoff until success, scope release, or budget exhaustion.

export const RECOVERY_RETRY_BASE_MS = 2_000
export const RECOVERY_RETRY_MAX_MS = 30_000
export const RECOVERY_RETRY_MAX_ATTEMPTS = 6

export function recoveryBackoffDelayMs(attempt: number): number {
  return Math.min(RECOVERY_RETRY_BASE_MS * 2 ** (attempt - 1), RECOVERY_RETRY_MAX_MS)
}

type RecoveryRetrySchedulerInput = {
  schedule: (fn: () => void, ms: number) => () => void
  isRecoverable: (scopeKey: string) => boolean
  retry: (scopeKey: string) => Promise<boolean>
}

export function createRecoveryRetryScheduler(input: RecoveryRetrySchedulerInput) {
  const pending = new Map<string, () => void>()
  const attempts = new Map<string, number>()

  const schedule = (scopeKey: string) => {
    if (pending.has(scopeKey) || !input.isRecoverable(scopeKey)) return
    const attempt = (attempts.get(scopeKey) ?? 0) + 1
    if (attempt > RECOVERY_RETRY_MAX_ATTEMPTS) return
    attempts.set(scopeKey, attempt)
    const cancel = input.schedule(() => {
      pending.delete(scopeKey)
      if (!input.isRecoverable(scopeKey)) return
      void input.retry(scopeKey).then((recovered) => {
        if (recovered) {
          attempts.delete(scopeKey)
          return
        }
        schedule(scopeKey)
      })
    }, recoveryBackoffDelayMs(attempt))
    pending.set(scopeKey, cancel)
  }

  return {
    schedule,
    cancel: (scopeKey: string) => {
      pending.get(scopeKey)?.()
      pending.delete(scopeKey)
      attempts.delete(scopeKey)
    },
    dispose: () => {
      for (const cancel of pending.values()) cancel()
      pending.clear()
      attempts.clear()
    },
  }
}
