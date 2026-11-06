import { describe, expect, test } from "bun:test"
import { createScopeReconnectRecovery } from "../../src/context/scope-reconnect-recovery"
import {
  RECOVERY_RETRY_BASE_MS,
  RECOVERY_RETRY_MAX_ATTEMPTS,
  RECOVERY_RETRY_MAX_MS,
  createRecoveryRetryScheduler,
  createScopeRecoveryCoordination,
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

describe("createScopeRecoveryCoordination", () => {
  const setup = () => {
    const published: Array<[string, number]> = []
    const recovery = createScopeReconnectRecovery((scopeKey, generation) => published.push([scopeKey, generation]))
    const { scheduled, scheduler, flush } = createHarness({})
    const coordination = createScopeRecoveryCoordination({ recovery, retries: scheduler })
    return { published, recovery, scheduled, scheduler, flush, coordination }
  }

  test("only a generation-owning success cancels a pending retry", async () => {
    const { published, recovery, scheduled, scheduler, coordination } = setup()

    scheduler.schedule("home")
    expect(scheduled).toHaveLength(1)

    // A bare event-gap replay success repairs the store but publishes no
    // generation, so the pending retry must survive.
    coordination.onReplaySettled("home", true)
    expect(recovery.version("home")).toBe(0)
    expect(scheduled).toHaveLength(1)

    const recovered = await coordination.runWithGeneration("home", 3, async () => true)
    expect(recovered).toBe(true)
    expect(recovery.version("home")).toBe(3)
    expect(published).toEqual([["home", 3]])
    expect(scheduled).toHaveLength(0)
  })

  test("a failed recovery schedules exactly one retry and keeps it pending", async () => {
    const { published, recovery, scheduled, coordination } = setup()

    coordination.onReplaySettled("home", false)
    expect(scheduled).toHaveLength(1)
    coordination.onReplaySettled("home", false)
    expect(scheduled).toHaveLength(1)

    const recovered = await coordination.runWithGeneration("home", 2, async () => false)
    expect(recovered).toBe(false)
    expect(recovery.version("home")).toBe(0)
    expect(published).toEqual([])
    expect(scheduled).toHaveLength(1)
  })

  test("a stale generation-owning success still cancels without republishing", async () => {
    const { published, scheduled, scheduler, coordination } = setup()

    await coordination.runWithGeneration("home", 4, async () => true)
    expect(published).toEqual([["home", 4]])

    scheduler.schedule("home")
    expect(scheduled).toHaveLength(1)

    await coordination.runWithGeneration("home", 4, async () => true)
    expect(published).toEqual([["home", 4]])
    expect(scheduled).toHaveLength(0)
  })
})
