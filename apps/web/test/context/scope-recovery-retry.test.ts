import { describe, expect, test } from "bun:test"
import {
  RECOVERY_RETRY_BASE_MS,
  RECOVERY_RETRY_MAX_ATTEMPTS,
  RECOVERY_RETRY_MAX_MS,
  createRecoveryRetryScheduler,
  recoveryBackoffDelayMs,
} from "../../src/context/scope-recovery-retry"

describe("recoveryBackoffDelayMs", () => {
  test("doubles per attempt and caps at the maximum", () => {
    expect(recoveryBackoffDelayMs(1)).toBe(RECOVERY_RETRY_BASE_MS)
    expect(recoveryBackoffDelayMs(2)).toBe(RECOVERY_RETRY_BASE_MS * 2)
    expect(recoveryBackoffDelayMs(3)).toBe(RECOVERY_RETRY_BASE_MS * 4)
    expect(recoveryBackoffDelayMs(4)).toBe(RECOVERY_RETRY_BASE_MS * 8)
    expect(recoveryBackoffDelayMs(5)).toBe(RECOVERY_RETRY_MAX_MS)
    expect(recoveryBackoffDelayMs(6)).toBe(RECOVERY_RETRY_MAX_MS)
  })
})

type ScheduledRetry = { fn: () => void; ms: number }

function createHarness(input: {
  isRecoverable?: (scopeKey: string) => boolean
  retry?: (scopeKey: string) => Promise<boolean>
}) {
  const scheduled: ScheduledRetry[] = []
  const scheduler = createRecoveryRetryScheduler({
    schedule: (fn, ms) => {
      let remove: () => void
      const entry: ScheduledRetry = {
        // A fired timer is gone from the schedule, mirroring setTimeout.
        fn: () => {
          remove()
          fn()
        },
        ms,
      }
      remove = () => {
        const index = scheduled.indexOf(entry)
        if (index !== -1) scheduled.splice(index, 1)
      }
      scheduled.push(entry)
      return remove
    },
    isRecoverable: input.isRecoverable ?? (() => true),
    retry: input.retry ?? (async () => true),
  })
  const flush = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return { scheduled, scheduler, flush }
}

describe("createRecoveryRetryScheduler", () => {
  test("runs the retry after the backoff delay and stops after success", async () => {
    let retries = 0
    const { scheduled, scheduler, flush } = createHarness({
      retry: async () => {
        retries++
        return true
      },
    })

    scheduler.schedule("home")
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(RECOVERY_RETRY_BASE_MS)

    scheduled[0]!.fn()
    await flush()
    expect(retries).toBe(1)
    expect(scheduled).toHaveLength(0)

    scheduler.schedule("home")
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(RECOVERY_RETRY_BASE_MS)
  })

  test("reschedules with the next backoff delay while retries fail", async () => {
    let retries = 0
    const { scheduled, scheduler, flush } = createHarness({
      retry: async () => {
        retries++
        return false
      },
    })

    scheduler.schedule("home")
    scheduled[0]!.fn()
    await flush()
    expect(retries).toBe(1)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(RECOVERY_RETRY_BASE_MS * 2)

    scheduled[0]!.fn()
    await flush()
    expect(retries).toBe(2)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(RECOVERY_RETRY_BASE_MS * 4)
  })

  test("stops scheduling after the maximum attempt budget", async () => {
    let retries = 0
    const { scheduled, scheduler, flush } = createHarness({
      retry: async () => {
        retries++
        return false
      },
    })

    scheduler.schedule("home")
    for (let attempt = 0; attempt < RECOVERY_RETRY_MAX_ATTEMPTS; attempt++) {
      expect(scheduled).toHaveLength(1)
      scheduled[0]!.fn()
      await flush()
    }
    expect(retries).toBe(RECOVERY_RETRY_MAX_ATTEMPTS)
    expect(scheduled).toHaveLength(0)
  })

  test("keeps a single pending timer per scope", () => {
    const { scheduled, scheduler } = createHarness({})
    scheduler.schedule("home")
    scheduler.schedule("home")
    expect(scheduled).toHaveLength(1)
  })

  test("does not schedule when the scope is not recoverable", () => {
    const { scheduled, scheduler } = createHarness({ isRecoverable: () => false })
    scheduler.schedule("home")
    expect(scheduled).toHaveLength(0)
  })

  test("skips the retry when the scope stops being recoverable before it fires", async () => {
    let recoverable = true
    let retries = 0
    const { scheduled, scheduler, flush } = createHarness({
      isRecoverable: () => recoverable,
      retry: async () => {
        retries++
        return true
      },
    })

    scheduler.schedule("home")
    recoverable = false
    scheduled[0]!.fn()
    await flush()
    expect(retries).toBe(0)
  })

  test("cancel prevents the pending retry and resets the attempt budget", async () => {
    let retries = 0
    const { scheduled, scheduler, flush } = createHarness({
      retry: async () => {
        retries++
        return false
      },
    })

    scheduler.schedule("home")
    scheduled[0]!.fn()
    await flush()
    expect(retries).toBe(1)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(RECOVERY_RETRY_BASE_MS * 2)

    scheduler.cancel("home")
    expect(scheduled).toHaveLength(0)

    scheduler.schedule("home")
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(RECOVERY_RETRY_BASE_MS)
  })

  test("dispose cancels every pending retry", () => {
    const { scheduled, scheduler } = createHarness({})
    scheduler.schedule("home")
    scheduler.schedule("/workspace/project")
    expect(scheduled).toHaveLength(2)
    scheduler.dispose()
    expect(scheduled).toHaveLength(0)
  })
})
